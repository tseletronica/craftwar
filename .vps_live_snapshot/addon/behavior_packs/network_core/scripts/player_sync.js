import { EnchantmentType, EquipmentSlot, ItemStack, Potions, system } from '@minecraft/server';
import { NETWORK_CONFIG } from './config.js';
import { requestJson } from './bridge_client.js';

const bundleCache = new Map();
const persistentIdentityCache = new Map();
const scheduledSaveRuns = new Map();
const transferLeaveMarkers = new Map();
const pendingTransferByPlayerId = new Map();
const redirectingPlayerById = new Map();
const PERSISTENT_ID_RETRY_TICKS = 5;
const PERSISTENT_ID_MAX_RETRIES = 8;
const DEFAULT_SCHEDULED_SAVE_DELAY_TICKS = 20;
const SAVE_RETRY_ATTEMPTS = 2;
const SAVE_RETRY_DELAY_TICKS = 10;
const TRANSITION_STATE_TTL_MS = 30000;

const ARMOR_SLOT_MAP = {
  head: EquipmentSlot.Head,
  chest: EquipmentSlot.Chest,
  legs: EquipmentSlot.Legs,
  feet: EquipmentSlot.Feet
};

function createDefaultDailyLoginState() {
  return {
    rewardGranted: false,
    rewardAmount: 0,
    claimedToday: false,
    streakDays: 0,
    rewardCycleDay: 0,
    nextRewardAmount: 0,
    activePlayersToday: 0,
    activePlayers7d: 0,
    weeklyCycleLength: 7
  };
}

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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function safeRead(fn, fallback = undefined) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

function readItemLore(item) {
  return normalizeStringArray(safeRead(() => item.getLore(), []));
}

function readItemEnchantments(item) {
  const enchantable = safeRead(() => item.getComponent('minecraft:enchantable'));
  const enchantments = safeRead(() => enchantable?.getEnchantments(), []);
  if (!Array.isArray(enchantments)) {
    return [];
  }

  return enchantments
    .map((entry) => ({
      typeId: String(entry?.type?.id || '').trim(),
      level: Math.max(1, Math.trunc(Number(entry?.level ?? 0)))
    }))
    .filter((entry) => entry.typeId && Number.isFinite(entry.level));
}

function readItemDurability(item) {
  const durability = safeRead(() => item.getComponent('minecraft:durability'));
  if (!durability) {
    return null;
  }

  const damage = Number(durability.damage);
  const unbreakable = Boolean(durability.unbreakable);
  if (!Number.isFinite(damage) && !unbreakable) {
    return null;
  }

  return {
    damage: Number.isFinite(damage) ? Math.max(0, Math.trunc(damage)) : 0,
    unbreakable
  };
}

function readItemDyeColor(item) {
  const dyeable = safeRead(() => item.getComponent('minecraft:dyeable'));
  const color = dyeable?.color;
  if (!color || !isFiniteNumber(color.red) || !isFiniteNumber(color.green) || !isFiniteNumber(color.blue)) {
    return null;
  }

  return {
    red: Math.max(0, Math.trunc(color.red)),
    green: Math.max(0, Math.trunc(color.green)),
    blue: Math.max(0, Math.trunc(color.blue))
  };
}

function readItemDynamicProperties(item) {
  const propertyIds = normalizeStringArray(safeRead(() => item.getDynamicPropertyIds(), []));
  if (!propertyIds.length) {
    return null;
  }

  const values = {};
  for (const propertyId of propertyIds) {
    const value = safeRead(() => item.getDynamicProperty(propertyId));
    if (value === undefined) {
      continue;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      values[propertyId] = value;
      continue;
    }

    if (
      value &&
      typeof value === 'object' &&
      isFiniteNumber(value.x) &&
      isFiniteNumber(value.y) &&
      isFiniteNumber(value.z)
    ) {
      values[propertyId] = {
        x: Number(value.x),
        y: Number(value.y),
        z: Number(value.z)
      };
    }
  }

  return Object.keys(values).length ? values : null;
}

function serializeItem(item, extra = {}) {
  if (!item) {
    return null;
  }

  const lore = readItemLore(item);
  const enchantments = readItemEnchantments(item);
  const durability = readItemDurability(item);
  const canDestroy = normalizeStringArray(safeRead(() => item.getCanDestroy(), []));
  const canPlaceOn = normalizeStringArray(safeRead(() => item.getCanPlaceOn(), []));
  const dynamicProperties = readItemDynamicProperties(item);
  const dyeColor = readItemDyeColor(item);
  const lockMode = safeRead(() => item.lockMode, null);
  const keepOnDeath = Boolean(safeRead(() => item.keepOnDeath, false));
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
    keepOnDeath,
    lockMode: lockMode ?? null,
    lore,
    enchantments,
    durability,
    canDestroy,
    canPlaceOn,
    dynamicProperties,
    dyeColor,
    potion,
    ...extra
  };
}

function applyItemLore(item, lore) {
  if (!Array.isArray(lore) || typeof item.setLore !== 'function') {
    return;
  }

  const normalizedLore = normalizeStringArray(lore);
  safeRead(() => item.setLore(normalizedLore.length ? normalizedLore : undefined));
}

function applyItemPlacementRules(item, itemData) {
  if (typeof item.setCanDestroy === 'function') {
    const canDestroy = normalizeStringArray(itemData?.canDestroy);
    safeRead(() => item.setCanDestroy(canDestroy.length ? canDestroy : undefined));
  }

  if (typeof item.setCanPlaceOn === 'function') {
    const canPlaceOn = normalizeStringArray(itemData?.canPlaceOn);
    safeRead(() => item.setCanPlaceOn(canPlaceOn.length ? canPlaceOn : undefined));
  }
}

function applyItemDynamicProperties(item, itemData) {
  if (!itemData?.dynamicProperties || typeof item.setDynamicProperties !== 'function') {
    return;
  }

  safeRead(() => item.setDynamicProperties(itemData.dynamicProperties));
}

function applyItemDurability(item, itemData) {
  const durability = safeRead(() => item.getComponent('minecraft:durability'));
  if (!durability || !itemData?.durability) {
    return;
  }

  if (typeof itemData.durability.unbreakable === 'boolean') {
    durability.unbreakable = itemData.durability.unbreakable;
  }

  const damage = Number(itemData.durability.damage);
  if (Number.isFinite(damage)) {
    durability.damage = Math.max(0, Math.trunc(damage));
  }
}

function applyItemDyeColor(item, itemData) {
  const dyeable = safeRead(() => item.getComponent('minecraft:dyeable'));
  const color = itemData?.dyeColor;
  if (
    !dyeable ||
    !color ||
    !isFiniteNumber(color.red) ||
    !isFiniteNumber(color.green) ||
    !isFiniteNumber(color.blue)
  ) {
    return;
  }

  dyeable.color = {
    red: Math.max(0, Math.trunc(color.red)),
    green: Math.max(0, Math.trunc(color.green)),
    blue: Math.max(0, Math.trunc(color.blue))
  };
}

function applyItemEnchantments(item, itemData) {
  const enchantable = safeRead(() => item.getComponent('minecraft:enchantable'));
  if (!enchantable || !Array.isArray(itemData?.enchantments)) {
    return;
  }

  const enchantments = itemData.enchantments
    .map((entry) => {
      const typeId = String(entry?.typeId || '').trim();
      const level = Math.max(1, Math.trunc(Number(entry?.level ?? 0)));
      if (!typeId || !Number.isFinite(level)) {
        return null;
      }

      try {
        return {
          type: new EnchantmentType(typeId),
          level
        };
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);

  if (!enchantments.length) {
    return;
  }

  safeRead(() => enchantable.removeAllEnchantments());

  if (typeof enchantable.addEnchantments === 'function') {
    const applied = safeRead(() => {
      enchantable.addEnchantments(enchantments);
      return true;
    }, false);

    if (applied) {
      return;
    }
  }

  if (typeof enchantable.addEnchantment === 'function') {
    for (const enchantment of enchantments) {
      safeRead(() => enchantable.addEnchantment(enchantment));
    }
  }
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

    if (typeof itemData.keepOnDeath === 'boolean') {
      item.keepOnDeath = itemData.keepOnDeath;
    }

    if (itemData.lockMode !== null && itemData.lockMode !== undefined) {
      item.lockMode = itemData.lockMode;
    }

    applyItemLore(item, itemData.lore);
    applyItemPlacementRules(item, itemData);
    applyItemDynamicProperties(item, itemData);
    applyItemDurability(item, itemData);
    applyItemDyeColor(item, itemData);
    applyItemEnchantments(item, itemData);
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

function serializeInventory(player, identitySource, metadata = {}, options = {}) {
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
      itemFormatVersion: 2,
      lastKnownLocation: readLocationState(player),
      transferDestinationSlug,
      ...metadata
    }
  };
}

function buildPlayerInventorySnapshot(player, options = {}) {
  const identity = options.identity || getPlayerIdentity(player);
  if (!identity?.xuid) {
    return null;
  }

  return {
    player,
    identity,
    previousBundle: getCachedBundle(player),
    inventoryState: serializeInventory(player, identity.identitySource, {
      saveReason: String(options.reason || 'manual')
    }, {
      transferDestinationSlug: options.transferDestinationSlug
    })
  };
}

function consumeTransferLeaveMarker(player) {
  const playerId = String(player?.id || '').trim();
  if (!playerId) {
    return null;
  }

  const marker = transferLeaveMarkers.get(playerId) || null;
  transferLeaveMarkers.delete(playerId);
  return marker;
}

export function markTransferLeave(player, destinationSlug = '') {
  const playerId = String(player?.id || '').trim();
  if (!playerId) {
    return false;
  }

  transferLeaveMarkers.set(playerId, {
    destinationSlug: String(destinationSlug || '').trim(),
    markedAt: Date.now()
  });
  return true;
}

export function clearTransferLeave(player) {
  const playerId = String(player?.id || '').trim();
  if (!playerId) {
    return false;
  }

  return transferLeaveMarkers.delete(playerId);
}

async function persistInventorySnapshot(snapshot) {
  const transferDestinationSlug =
    normalizeServerSlug(snapshot?.inventoryState?.metadata?.transferDestinationSlug) || null;
  const response = await requestJson('POST', '/internal/player-sync/inventory', {
    xuid: snapshot.identity.xuid,
    gamertag: snapshot.identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: snapshot.identity.legacyXuids,
    transferDestinationSlug,
    inventory: snapshot.inventoryState.inventory,
    armor: snapshot.inventoryState.armor,
    enderChest: snapshot.inventoryState.enderChest,
    offhand: snapshot.inventoryState.offhand,
    hotbarSlot: snapshot.inventoryState.hotbarSlot,
    experienceLevel: snapshot.inventoryState.experienceLevel,
    totalExperience: snapshot.inventoryState.totalExperience,
    health: snapshot.inventoryState.health,
    hunger: snapshot.inventoryState.hunger,
    saturation: snapshot.inventoryState.saturation,
    metadata: snapshot.inventoryState.metadata
  });

  if (!response.ok || !response.data) {
    return { ok: false, error: readErrorCode(response) };
  }

  let nextBundle = null;
  if (snapshot.previousBundle) {
    nextBundle = {
      ...snapshot.previousBundle,
      inventory: {
        revision: Number(response.data.inventoryVersion ?? snapshot.previousBundle?.inventory?.revision ?? 0),
        data: snapshot.inventoryState
      }
    };
  }

  if (snapshot.player?.id && nextBundle) {
    cacheBundle(snapshot.player, nextBundle);
  }

  return { ok: true, bundle: nextBundle };
}

async function persistInventorySnapshotWithRetry(snapshot, attempts = SAVE_RETRY_ATTEMPTS) {
  let lastResult = null;

  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    lastResult = await persistInventorySnapshot(snapshot).catch((error) => ({
      ok: false,
      error: error?.message || 'save_failed'
    }));

    if (lastResult?.ok) {
      return lastResult;
    }

    if (attempt < attempts) {
      await waitTicks(SAVE_RETRY_DELAY_TICKS);
    }
  }

  return lastResult || { ok: false, error: 'save_failed' };
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
  const dailyLoginSource =
    state?.dailyLoginReward && typeof state.dailyLoginReward === 'object'
      ? state.dailyLoginReward
      : state?.dailyLogin && typeof state.dailyLogin === 'object'
        ? state.dailyLogin
        : null;

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
    },
    dailyLogin: {
      rewardGranted: Boolean(dailyLoginSource?.rewardGranted),
      rewardAmount: Number(dailyLoginSource?.rewardAmount ?? 0),
      claimedToday: Boolean(dailyLoginSource?.claimedToday),
      streakDays: Number(dailyLoginSource?.streakDays ?? 0),
      rewardCycleDay: Number(dailyLoginSource?.rewardCycleDay ?? 0),
      nextRewardAmount: Number(dailyLoginSource?.nextRewardAmount ?? 0),
      activePlayersToday: Number(dailyLoginSource?.activePlayersToday ?? 0),
      activePlayers7d: Number(dailyLoginSource?.activePlayers7d ?? 0),
      weeklyCycleLength: Number(dailyLoginSource?.weeklyCycleLength ?? 7)
    }
  };
}

function cacheBundle(player, bundle) {
  bundleCache.set(player.id, bundle);
  return bundle;
}

function applyBundleToPlayer(player, state, options = {}) {
  const bundle = cacheBundle(player, normalizeBundle(state));
  if (options.applyInventory !== false) {
    applyInventory(player, bundle.inventory.data);
  }
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

export async function reloadPlayerBundle(player, options = {}) {
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

  const bundle = applyBundleToPlayer(player, response.data, options);

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
  const immediateSnapshot = buildPlayerInventorySnapshot(player, {
    reason: options.reason,
    transferDestinationSlug: options.transferDestinationSlug
  });
  if (immediateSnapshot) {
    return persistInventorySnapshotWithRetry(immediateSnapshot);
  }

  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const fallbackSnapshot = buildPlayerInventorySnapshot(player, {
    identity,
    reason: options.reason,
    transferDestinationSlug: options.transferDestinationSlug
  });
  if (!fallbackSnapshot) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  return persistInventorySnapshotWithRetry(fallbackSnapshot);
}

export function schedulePlayerStateSave(player, options = {}) {
  const playerId = String(player?.id || '').trim();
  if (!playerId) {
    return false;
  }

  const delayTicks = Math.max(1, Math.trunc(Number(options.delayTicks ?? DEFAULT_SCHEDULED_SAVE_DELAY_TICKS)));
  const runId = (scheduledSaveRuns.get(playerId)?.runId ?? 0) + 1;
  const reason = String(options.reason || 'inventory_change');

  scheduledSaveRuns.set(playerId, { runId, reason });
  system.runTimeout(async () => {
    const scheduled = scheduledSaveRuns.get(playerId);
    if (!scheduled || scheduled.runId !== runId) {
      return;
    }

    scheduledSaveRuns.delete(playerId);
    const result = await savePlayerState(player, { reason }).catch((error) => ({
      ok: false,
      error: error?.message || 'save_failed'
    }));

    if (!result?.ok) {
      console.warn(`[PLAYER_SYNC] Falha ao salvar estado agendado de ${playerId}: ${result?.error || 'save_failed'}`);
    }
  }, delayTicks);

  return true;
}

export async function disconnectPlayer(player) {
  const playerId = String(player?.id || '').trim();
  if (playerId) {
    scheduledSaveRuns.delete(playerId);
  }

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

  const transferLeave = consumeTransferLeaveMarker(player);
  const transferDestinationSlug = getPlayerTransferIntent(player) || String(transferLeave?.destinationSlug || '').trim() || null;

  const snapshot = buildPlayerInventorySnapshot(player, { reason: 'leave' });
  const identity = snapshot?.identity || (await resolvePlayerIdentity(player));
  if (!identity.xuid) {
    clearPlayerTransferIntent(player);
    return { ok: true };
  }

  if (!transferDestinationSlug) {
    if (snapshot) {
      const saveResult = await persistInventorySnapshotWithRetry(snapshot);
      if (!saveResult.ok) {
        console.warn(`[PLAYER_SYNC] Falha ao salvar antes do leave de ${identity.gamertag}: ${saveResult.error}`);
      }
    } else {
      const saveResult = await savePlayerState(player, { reason: 'leave' }).catch((error) => ({
        ok: false,
        error: error?.message || 'save_failed'
      }));

      if (!saveResult.ok) {
        console.warn(`[PLAYER_SYNC] Falha ao salvar estado no leave de ${identity.gamertag}: ${saveResult.error}`);
      }
    }
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

export async function purchaseBalance(player, amount, options = {}) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const normalizedAmount = Number(amount);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0) {
    return { ok: false, error: 'invalid_amount' };
  }

  const response = await requestJson('POST', '/internal/economy/purchase', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    amount: normalizedAmount,
    reason: String(options.reason || 'npc_shop'),
    shopId: String(options.shopId || ''),
    itemId: String(options.itemId || '')
  });

  if (!response.ok || !response.data) {
    return {
      ok: false,
      error: readErrorCode(response),
      details: response.data?.details || null
    };
  }

  setCachedBalance(player, response.data.balance);

  return {
    ok: true,
    amount: Number(response.data.amount ?? normalizedAmount),
    balance: Number(response.data.balance ?? 0),
    transactionId: String(response.data.transactionId || '')
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

export async function chooseRace(player, raceName) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const response = await requestJson('POST', '/internal/races/select', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    raceName
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
    raceName: String(response.data.raceName || raceName),
    bundle
  };
}

export async function reserveRacePower(player, raceKey, cooldownMs) {
  const identity = await resolvePlayerIdentity(player);
  if (!identity.xuid) {
    return { ok: false, error: 'missing_persistent_id' };
  }

  const response = await requestJson('POST', '/internal/player-sync/race-power', {
    xuid: identity.xuid,
    gamertag: identity.gamertag,
    serverSlug: NETWORK_CONFIG.serverSlug,
    legacyXuids: identity.legacyXuids,
    raceKey,
    cooldownMs
  });

  if (!response.ok || !response.data) {
    return {
      ok: false,
      error: readErrorCode(response),
      details: response.data?.details || null
    };
  }

  return {
    ok: Boolean(response.data.ok),
    reason: String(response.data.reason || ''),
    nextAvailableAt: Number(response.data.nextAvailableAt ?? 0),
    remainingMs: Number(response.data.remainingMs ?? 0)
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
