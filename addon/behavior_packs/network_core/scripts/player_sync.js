import { EquipmentSlot, ItemStack, Potions, system } from '@minecraft/server';
import { NETWORK_CONFIG } from './config.js';
import { requestJson } from './bridge_client.js';

const bundleCache = new Map();
const persistentIdentityCache = new Map();
const pendingTransferByPlayerId = new Map();
const redirectingPlayerById = new Map();
const PERSISTENT_ID_RETRY_TICKS = 5;
const PERSISTENT_ID_MAX_RETRIES = 8;
const TRANSITION_STATE_TTL_MS = 30000;

const ARMOR_SLOT_MAP = {
  head: EquipmentSlot.Head,
  chest: EquipmentSlot.Chest,
  legs: EquipmentSlot.Legs,
  feet: EquipmentSlot.Feet
};

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeServerSlug(value) {
  return String(value || '').trim().toLowerCase();
}

function isFreshTransitionEntry(entry) {
  return Date.now() - Number(entry?.createdAt || 0) <= TRANSITION_STATE_TTL_MS;
}

function getPlayerTransitionEntry(store, player) {
  const playerId = String(player?.id || '').trim();
  if (!playerId) {
    return null;
  }

  const entry = store.get(playerId) || null;
  if (!entry) {
    return null;
  }

  if (isFreshTransitionEntry(entry)) {
    return entry;
  }

  store.delete(playerId);
  return null;
}

function readPlayerName(player) {
  try {
    return String(player?.name || '').trim();
  } catch (error) {
    return '';
  }
}

export function rememberPersistentIdentity(playerName, persistentId) {
  const normalizedName = normalizeName(playerName);
  const normalizedId = String(persistentId || '').trim();

  if (!normalizedName || !normalizedId) {
    return;
  }

  persistentIdentityCache.set(normalizedName, normalizedId);
}

export function markPlayerTransferIntent(player, destinationSlug) {
  const playerId = String(player?.id || '').trim();
  const normalizedDestination = normalizeServerSlug(destinationSlug);

  if (!playerId || !normalizedDestination) {
    return;
  }

  pendingTransferByPlayerId.set(playerId, {
    destinationSlug: normalizedDestination,
    createdAt: Date.now()
  });
}

export function clearPlayerTransferIntent(player) {
  const playerId = typeof player === 'string' ? player.trim() : String(player?.id || '').trim();
  if (!playerId) {
    return;
  }

  pendingTransferByPlayerId.delete(playerId);
}

function getPlayerTransferIntent(player) {
  return getPlayerTransitionEntry(pendingTransferByPlayerId, player)?.destinationSlug || null;
}

export function markPlayerAwaitingRedirect(player, destinationSlug) {
  const playerId = String(player?.id || '').trim();
  const normalizedDestination = normalizeServerSlug(destinationSlug);

  if (!playerId || !normalizedDestination) {
    return;
  }

  redirectingPlayerById.set(playerId, {
    destinationSlug: normalizedDestination,
    createdAt: Date.now()
  });
}

export function clearPlayerAwaitingRedirect(player) {
  const playerId = typeof player === 'string' ? player.trim() : String(player?.id || '').trim();
  if (!playerId) {
    return;
  }

  redirectingPlayerById.delete(playerId);
}

function getPlayerAwaitingRedirect(player) {
  return getPlayerTransitionEntry(redirectingPlayerById, player)?.destinationSlug || null;
}

export function isPlayerInTransientNetworkState(player) {
  return Boolean(getPlayerTransferIntent(player) || getPlayerAwaitingRedirect(player));
}

function getPlayerIdentity(player) {
  const gamertag = readPlayerName(player);
  const legacyNameIdentity = normalizeName(gamertag);
  const persistentId = persistentIdentityCache.get(legacyNameIdentity) || '';

  return {
    xuid: persistentId,
    gamertag,
    legacyXuids:
      persistentId && legacyNameIdentity && persistentId !== legacyNameIdentity
        ? [legacyNameIdentity]
        : [],
    identitySource: persistentId ? 'persistentId' : 'pendingPersistentId'
  };
}

function waitTicks(ticks) {
  return new Promise((resolve) => {
    system.runTimeout(resolve, Math.max(1, Number(ticks) || 1));
  });
}

async function resolvePlayerIdentity(player) {
  let identity = getPlayerIdentity(player);

  for (let attempt = 0; attempt < PERSISTENT_ID_MAX_RETRIES && !identity.xuid; attempt += 1) {
    await waitTicks(PERSISTENT_ID_RETRY_TICKS);
    identity = getPlayerIdentity(player);
  }

  return identity;
}

function readErrorCode(response) {
  return (
    response?.data?.error ||
    response?.data?.code ||
    response?.data?.message ||
    `http_${response?.status ?? 500}`
  );
}

function serializeItem(item, extra = {}) {
  if (!item) {
    return null;
  }

  let potion = null;
  try {
    const potionComponent = item.getComponent?.('minecraft:potion');
    const effectTypeId = String(potionComponent?.potionEffectType?.id || '').trim();
    const deliveryTypeId = String(potionComponent?.potionDeliveryType?.id || '').trim();

    if (effectTypeId && deliveryTypeId) {
      potion = {
        effectTypeId,
        deliveryTypeId
      };
    }
  } catch (error) {
  }

  return {
    typeId: item.typeId,
    amount: item.amount,
    nameTag: item.nameTag || null,
    potion,
    ...extra
  };
}

function deserializeItem(itemData) {
  if (!itemData?.typeId || !itemData?.amount) {
    return undefined;
  }

  try {
    let item = null;
    const potionEffectTypeId = String(itemData?.potion?.effectTypeId || '').trim();
    const potionDeliveryTypeId = String(itemData?.potion?.deliveryTypeId || '').trim();

    if (potionEffectTypeId && potionDeliveryTypeId) {
      try {
        const effectType =
          typeof Potions.getEffectType === 'function'
            ? (Potions.getEffectType(potionEffectTypeId) || potionEffectTypeId)
            : potionEffectTypeId;
        const deliveryType =
          typeof Potions.getDeliveryType === 'function'
            ? (Potions.getDeliveryType(potionDeliveryTypeId) || potionDeliveryTypeId)
            : potionDeliveryTypeId;

        item = Potions.resolve(effectType, deliveryType);
        try {
          item.amount = Number(itemData.amount);
        } catch (error) {
        }
      } catch (error) {
        item = null;
      }
    }

    if (!item) {
      item = new ItemStack(itemData.typeId, Number(itemData.amount));
    }

    if (itemData.nameTag) {
      item.nameTag = itemData.nameTag;
    }

    return item;
  } catch (error) {
    return undefined;
  }
}

function readHealthState(player) {
  const healthComponent = player.getComponent('minecraft:health');
  const foodComponent = player.getComponent('minecraft:food');

  return {
    health: typeof healthComponent?.currentValue === 'number' ? healthComponent.currentValue : 20,
    hunger: typeof foodComponent?.foodLevel === 'number' ? foodComponent.foodLevel : 20,
    saturation: typeof foodComponent?.saturationLevel === 'number' ? foodComponent.saturationLevel : 5
  };
}

function readLocationState(player) {
  const rawLocation = player?.location || {};

  return {
    serverSlug: NETWORK_CONFIG.serverSlug,
    dimensionId: String(player?.dimension?.id || 'minecraft:overworld'),
    x: Number.isFinite(Number(rawLocation.x)) ? Number(rawLocation.x) : 0,
    y: Number.isFinite(Number(rawLocation.y)) ? Number(rawLocation.y) : 0,
    z: Number.isFinite(Number(rawLocation.z)) ? Number(rawLocation.z) : 0
  };
}

function serializeInventory(player, identitySource, options = {}) {
  const inventoryComponent = player.getComponent('minecraft:inventory');
  const container = inventoryComponent?.container;
  const equippable = player.getComponent('minecraft:equippable');
  const healthState = readHealthState(player);
  const transferDestinationSlug = normalizeServerSlug(options?.transferDestinationSlug) || null;

  const inventory = [];
  if (container) {
    for (let slot = 0; slot < container.size; slot += 1) {
      const item = container.getItem(slot);
      const serialized = serializeItem(item, { slot });
      if (serialized) {
        inventory.push(serialized);
      }
    }
  }

  const armor = [];
  if (equippable) {
    for (const [slot, slotId] of Object.entries(ARMOR_SLOT_MAP)) {
      const item = equippable.getEquipment(slotId);
      const serialized = serializeItem(item, { slot });
      if (serialized) {
        armor.push(serialized);
      }
    }
  }

  const offhand = equippable
    ? serializeItem(equippable.getEquipment(EquipmentSlot.Offhand))
    : null;

  return {
    inventory,
    armor,
    enderChest: [],
    offhand: offhand || {},
    hotbarSlot: typeof player?.selectedSlotIndex === 'number' ? player.selectedSlotIndex : 0,
    experienceLevel: typeof player?.level === 'number' ? player.level : 0,
    totalExperience: typeof player?.totalXp === 'number' ? player.totalXp : 0,
    health: healthState.health,
    hunger: healthState.hunger,
    saturation: healthState.saturation,
    metadata: {
      savedAt: new Date().toISOString(),
      sourceServer: NETWORK_CONFIG.serverSlug,
      identitySource,
      lastKnownLocation: readLocationState(player),
      transferDestinationSlug
    }
  };
}

function clearInventory(player) {
  const inventoryComponent = player.getComponent('minecraft:inventory');
  const container = inventoryComponent?.container;
  if (container) {
    for (let slot = 0; slot < container.size; slot += 1) {
      container.setItem(slot, undefined);
    }
  }

  const equippable = player.getComponent('minecraft:equippable');
  if (equippable) {
    for (const slotId of Object.values(ARMOR_SLOT_MAP)) {
      equippable.setEquipment(slotId, undefined);
    }
    equippable.setEquipment(EquipmentSlot.Offhand, undefined);
  }
}

function applyInventory(player, inventoryState) {
  if (!inventoryState) {
    return;
  }

  clearInventory(player);

  const inventoryComponent = player.getComponent('minecraft:inventory');
  const container = inventoryComponent?.container;
  if (container && Array.isArray(inventoryState.inventory)) {
    for (const slotData of inventoryState.inventory) {
      if (typeof slotData?.slot !== 'number') {
        continue;
      }

      const item = deserializeItem(slotData);
      if (item) {
        container.setItem(slotData.slot, item);
      }
    }
  }

  const equippable = player.getComponent('minecraft:equippable');
  if (!equippable) {
    return;
  }

  if (Array.isArray(inventoryState.armor)) {
    for (const armorData of inventoryState.armor) {
      const slotId = ARMOR_SLOT_MAP[armorData?.slot];
      if (slotId === undefined) {
        continue;
      }

      const item = deserializeItem(armorData);
      if (item) {
        equippable.setEquipment(slotId, item);
      }
    }
  }

  const offhandItem = deserializeItem(inventoryState.offhand);
  if (offhandItem) {
    equippable.setEquipment(EquipmentSlot.Offhand, offhandItem);
  }
}

function normalizeBundle(state) {
  return {
    profile: {
      displayName: state?.gamertag ?? null,
      race: state?.race ?? null,
      className: state?.className ?? null,
      title: state?.title ?? null,
      kingdomSlug: state?.kingdomSlug ?? null,
      kingdomName: state?.kingdomName ?? null,
      nationSlug: state?.nationSlug ?? null,
      nationName: state?.nationName ?? null,
      clanId: state?.clanId ?? null,
      clanName: state?.clanName ?? null,
      clanTag: state?.clanTag ?? null
    },
    inventory: {
      revision: Number(state?.inventoryVersion ?? 0),
      data: {
        inventory: Array.isArray(state?.inventory) ? state.inventory : [],
        armor: Array.isArray(state?.armor) ? state.armor : [],
        enderChest: Array.isArray(state?.enderChest) ? state.enderChest : [],
        offhand: state?.offhand && typeof state.offhand === 'object' ? state.offhand : {},
        hotbarSlot: Number(state?.hotbarSlot ?? 0),
        experienceLevel: Number(state?.experienceLevel ?? 0),
        totalExperience: Number(state?.totalExperience ?? 0),
        health: Number(state?.health ?? 20),
        hunger: Number(state?.hunger ?? 20),
        saturation: Number(state?.saturation ?? 5)
      }
    },
    economy: {
      balance: Number(state?.dracoBalance ?? 0),
      nationBalance: Number(state?.nationDracoBalance ?? 0),
      kingdomBalance: Number(state?.kingdomDracoBalance ?? 0)
    }
  };
}

function cacheBundle(player, bundle) {
  bundleCache.set(player.id, bundle);
  return bundle;
}

function applyBundleToPlayer(player, state) {
  const bundle = cacheBundle(player, normalizeBundle(state));
  applyInventory(player, bundle.inventory.data);
  return bundle;
}

export function setCachedBalance(player, balance) {
  const currentBundle = getCachedBundle(player);
  if (!currentBundle) {
    return null;
  }

  const nextBundle = {
    ...currentBundle,
    economy: {
      ...(currentBundle.economy || {}),
      balance: Number(balance ?? 0)
    }
  };

  bundleCache.set(player.id, nextBundle);
  return nextBundle;
}

export function getCachedBundle(player) {
  return bundleCache.get(player.id) || null;
}

export async function heartbeatServerPresence() {
  return { ok: true };
}

export async function connectPlayer(player) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const response = await requestJson('POST', '/internal/player-sync/join', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids
  });

  if (!response.ok || !response.data) {
    return { ok: false, error: readErrorCode(response) };
  }

  const redirect = response.data?.redirect && typeof response.data.redirect === 'object'
    ? {
        serverSlug: normalizeServerSlug(response.data.redirect.serverSlug),
        serverName: String(response.data.redirect.serverName || response.data.redirect.serverSlug || '').trim(),
        reason: String(response.data.redirect.reason || 'resume').trim()
      }
    : null;

  if (redirect?.serverSlug) {
    clearPlayerTransferIntent(player);
    clearPlayerAwaitingRedirect(player);
    return {
      ok: true,
      redirected: true,
      redirect,
      bundle: null
    };
  }

  const state = response.data?.state || response.data;
  const bundle = applyBundleToPlayer(player, state);
  clearPlayerTransferIntent(player);
  clearPlayerAwaitingRedirect(player);

  return { ok: true, redirected: false, redirect: null, bundle };
}

export async function reloadPlayerBundle(player) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const response = await requestJson('POST', '/internal/player-sync/state', {
    xuid: identity.xuid
  });

  if (!response.ok || !response.data) {
    return { ok: false, error: readErrorCode(response) };
  }

  const bundle = applyBundleToPlayer(player, response.data);

  return { ok: true, bundle };
}

export async function heartbeatPlayer(player) {
  const cachedBundle = getCachedBundle(player);
  return {
    ok: Boolean(cachedBundle),
    error: cachedBundle ? null : 'missing_state'
  };
}

export async function savePlayerState(player, options = {}) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const transferDestinationSlug = normalizeServerSlug(options?.transferDestinationSlug) || null;
  const inventoryState = serializeInventory(player, identity.identitySource, {
    transferDestinationSlug
  });
  const response = await requestJson('POST', '/internal/player-sync/inventory', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    transferDestinationSlug,
    inventory: inventoryState.inventory,
    armor: inventoryState.armor,
    enderChest: inventoryState.enderChest,
    offhand: inventoryState.offhand,
    hotbarSlot: inventoryState.hotbarSlot,
    experienceLevel: inventoryState.experienceLevel,
    totalExperience: inventoryState.totalExperience,
    health: inventoryState.health,
    hunger: inventoryState.hunger,
    saturation: inventoryState.saturation,
    metadata: inventoryState.metadata
  });

  if (!response.ok || !response.data) {
    return { ok: false, error: readErrorCode(response) };
  }

  const previousBundle = getCachedBundle(player);
  const nextBundle = {
    profile: previousBundle?.profile || {
      displayName: identity.gamertag,
      race: null,
      className: null,
      title: null,
      kingdomSlug: null,
      kingdomName: null,
      nationSlug: null,
      nationName: null,
      clanId: null,
      clanName: null,
      clanTag: null
    },
    inventory: {
      revision: Number(response.data.inventoryVersion ?? previousBundle?.inventory?.revision ?? 0),
      data: inventoryState
    },
    economy: previousBundle?.economy || {
      balance: 0,
      nationBalance: 0,
      kingdomBalance: 0
    }
  };

  cacheBundle(player, nextBundle);

  return { ok: true, bundle: nextBundle };
}

export async function disconnectPlayer(player) {
  const redirectDestinationSlug = getPlayerAwaitingRedirect(player);
  if (redirectDestinationSlug) {
    bundleCache.delete(player.id);
    clearPlayerAwaitingRedirect(player);
    clearPlayerTransferIntent(player);
    return {
      ok: true,
      skipped: 'redirect'
    };
  }

  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    clearPlayerTransferIntent(player);
    return { ok: true };
  }

  const transferDestinationSlug = getPlayerTransferIntent(player);

  if (!transferDestinationSlug) {
    await savePlayerState(player).catch(() => null);
  }

  const response = await requestJson('POST', '/internal/player-sync/leave', {
    xuid: identity.xuid,
    serverSlug: NETWORK_CONFIG.serverSlug,
    reason: transferDestinationSlug ? `transfer:${transferDestinationSlug}` : 'leave'
  });

  bundleCache.delete(player.id);
  clearPlayerTransferIntent(player);
  clearPlayerAwaitingRedirect(player);

  return {
    ok: response.ok,
    error: response.ok ? null : readErrorCode(response)
  };
}

export async function transferBalance(player, targetGamertag, amount) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const normalizedTargetGamertag = String(targetGamertag || '').trim();
  const normalizedAmount = Number(amount);

  if (!normalizedTargetGamertag) {
    return { ok: false, error: 'recipient_not_found' };
  }

  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0) {
    return { ok: false, error: 'invalid_amount' };
  }

  const response = await requestJson('POST', '/internal/economy/transfer', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    targetGamertag: normalizedTargetGamertag,
    amount: normalizedAmount,
    reason: 'command_pay'
  });

  if (!response.ok || !response.data) {
    return {
      ok: false,
      error: readErrorCode(response),
      details: response.data?.details || null
    };
  }

  setCachedBalance(player, response.data.senderBalance);

  return {
    ok: true,
    amount: Number(response.data.amount ?? normalizedAmount),
    senderBalance: Number(response.data.senderBalance ?? 0),
    recipientBalance: Number(response.data.recipientBalance ?? 0),
    recipientGamertag: String(response.data.recipientGamertag || normalizedTargetGamertag)
  };
}

export async function mintBalance(player, targetGamertag, amount) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const normalizedTargetGamertag = String(targetGamertag || '').trim();
  const normalizedAmount = Number(amount);

  if (!normalizedTargetGamertag) {
    return { ok: false, error: 'recipient_not_found' };
  }

  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0) {
    return { ok: false, error: 'invalid_amount' };
  }

  const response = await requestJson('POST', '/internal/economy/mint', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    targetGamertag: normalizedTargetGamertag,
    amount: normalizedAmount,
    reason: 'admin_mint'
  });

  if (!response.ok || !response.data) {
    return {
      ok: false,
      error: readErrorCode(response),
      details: response.data?.details || null
    };
  }

  return {
    ok: true,
    amount: Number(response.data.amount ?? normalizedAmount),
    recipientBalance: Number(response.data.recipientBalance ?? 0),
    recipientGamertag: String(response.data.recipientGamertag || normalizedTargetGamertag)
  };
}

export async function getTopRicos() {
  const response = await requestJson('GET', '/internal/economy/top');

  if (!response.ok || !response.data) {
    return {
      ok: false,
      error: readErrorCode(response)
    };
  }

  return {
    ok: true,
    top: response.data.map(item => ({
      gamertag: String(item.gamertag || '---'),
      balance: Number(item.balance ?? 0)
    }))
  };
}

export async function chooseNation(player, nationSlug) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const response = await requestJson('POST', '/internal/nations/select', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    nationSlug
  });

  if (!response.ok || !response.data?.state) {
    return {
      ok: false,
      error: readErrorCode(response),
      details: response.data?.details || null
    };
  }

  const bundle = applyBundleToPlayer(player, response.data.state);

  return {
    ok: true,
    nationSlug: String(response.data.nationSlug || nationSlug),
    nationName: String(response.data.nationName || ''),
    bundle
  };
}

export async function promoteNationMember(player, targetGamertag, className) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const response = await requestJson('POST', '/internal/nations/promote', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    targetGamertag,
    className
  });

  if (!response.ok || !response.data) {
    return {
      ok: false,
      error: readErrorCode(response),
      details: response.data?.details || null
    };
  }

  return {
    ok: true,
    targetGamertag: String(response.data.targetGamertag || targetGamertag),
    className: String(response.data.className || className),
    nationName: String(response.data.nationName || ''),
    targetState: response.data.targetState || null
  };
}

export async function demoteNationMember(player, targetGamertag) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const response = await requestJson('POST', '/internal/nations/demote', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    targetGamertag
  });

  if (!response.ok || !response.data) {
    return {
      ok: false,
      error: readErrorCode(response),
      details: response.data?.details || null
    };
  }

  return {
    ok: true,
    targetGamertag: String(response.data.targetGamertag || targetGamertag),
    nationName: String(response.data.nationName || ''),
    targetState: response.data.targetState || null
  };
}

export async function expelNationMember(player, targetGamertag) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const response = await requestJson('POST', '/internal/nations/expel', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    targetGamertag
  });

  if (!response.ok || !response.data) {
    return {
      ok: false,
      error: readErrorCode(response),
      details: response.data?.details || null
    };
  }

  return {
    ok: true,
    targetGamertag: String(response.data.targetGamertag || targetGamertag),
    formerNationName: String(response.data.formerNationName || ''),
    targetState: response.data.targetState || null
  };
}
