import { CommandPermissionLevel, GameMode, system, world } from '@minecraft/server';
import { NETWORK_CONFIG } from './config.js';
import { getCachedBundle } from './player_sync.js';

const CREATIVE_MODE = GameMode.Creative ?? GameMode.creative ?? 'creative';
const SURVIVAL_MODE = GameMode.Survival ?? GameMode.survival ?? 'survival';
const ADVENTURE_MODE = GameMode.Adventure ?? GameMode.adventure ?? 'adventure';
const ADMIN_COMMAND_LEVEL =
  CommandPermissionLevel.Admin ?? CommandPermissionLevel.GameDirectors ?? 2;
const NATION_SERVER_SLUGS = new Set(['fire', 'water', 'earth', 'air']);
const GAMERULE_REAPPLY_INTERVAL_TICKS = 600;
const MODE_ENFORCEMENT_INTERVAL_TICKS = 40;
const ACTION_NOTICE_COOLDOWN_MS = 4000;
const actionNoticeCooldowns = new Map();

const adminGamertags = new Set(
  NETWORK_CONFIG.adminCreativeGamertags.map((entry) => normalizeName(entry))
);

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeDimensionId(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized.endsWith('the_end') || normalized.endsWith(':the_end')) {
    return 'the_end';
  }

  if (normalized.endsWith('nether') || normalized.endsWith(':nether')) {
    return 'nether';
  }

  return 'overworld';
}

function isCreativeGamertag(player) {
  return adminGamertags.has(normalizeName(player?.name));
}

function isCreativeGameMode(value) {
  return String(value ?? '').trim().toLowerCase() === String(CREATIVE_MODE).trim().toLowerCase();
}

function isSurvivalGameMode(value) {
  return String(value ?? '').trim().toLowerCase() === String(SURVIVAL_MODE).trim().toLowerCase();
}

function isAdventureGameMode(value) {
  return String(value ?? '').trim().toLowerCase() === String(ADVENTURE_MODE).trim().toLowerCase();
}

function isValidPlayer(player) {
  try {
    if (!player) {
      return false;
    }

    if (typeof player.isValid === 'function') {
      return player.isValid();
    }

    return true;
  } catch (error) {
    return false;
  }
}

function send(player, message) {
  try {
    player.sendMessage(message);
  } catch (error) {
  }
}

function sendThrottled(player, key, message, cooldownMs = ACTION_NOTICE_COOLDOWN_MS) {
  if (!isValidPlayer(player)) {
    return;
  }

  const now = Date.now();
  const mapKey = `${player.id}:${key}`;
  const nextAllowedAt = actionNoticeCooldowns.get(mapKey) || 0;
  if (now < nextAllowedAt) {
    return;
  }

  actionNoticeCooldowns.set(mapKey, now + cooldownMs);
  send(player, message);
}

function getProtectedNationServerSlug() {
  const serverSlug = normalizeName(NETWORK_CONFIG.serverSlug);
  return NATION_SERVER_SLUGS.has(serverSlug) ? serverSlug : null;
}

function getPlayerNationSlug(player) {
  return normalizeName(getCachedBundle(player)?.profile?.nationSlug);
}

function getPlayerRoleKey(player) {
  const className = normalizeText(getCachedBundle(player)?.profile?.className);
  if (!className) {
    return null;
  }

  const warriorTokens = [
    'cacador do ceu',
    'combat',
    'guardiao da floresta',
    'guerreiro',
    'lamina de labareda',
    'tritao'
  ];
  if (warriorTokens.some((token) => className.includes(token))) {
    return 'warrior';
  }

  const builderTokens = [
    'construtor',
    'engenheiro de nuvens',
    'geologo',
    'mestre da fornalha',
    'mestre das mares'
  ];
  if (builderTokens.some((token) => className.includes(token))) {
    return 'builder';
  }

  return null;
}

function getProtectedNationAccessType(player) {
  const protectedNationSlug = getProtectedNationServerSlug();
  if (!protectedNationSlug || !isValidPlayer(player) || isCreativeGamertag(player)) {
    return 'exempt';
  }

  if (getPlayerNationSlug(player) !== protectedNationSlug) {
    return 'visitor';
  }

  const roleKey = getPlayerRoleKey(player);
  if (roleKey === 'builder' || roleKey === 'warrior') {
    return roleKey;
  }

  return 'citizen';
}

function isVisitorInProtectedNation(player) {
  return getProtectedNationAccessType(player) === 'visitor';
}

function trySetGameMode(player, targetMode) {
  try {
    player.setGameMode(targetMode);
    return true;
  } catch (error) {
    return false;
  }
}

function tryRunWorldCommand(command) {
  const overworld = world.getDimension('overworld');

  try {
    if (typeof overworld?.runCommandAsync === 'function') {
      overworld.runCommandAsync(command).catch(() => {});
      return true;
    }
  } catch (error) {
  }

  try {
    if (typeof overworld?.runCommand === 'function') {
      overworld.runCommand(command);
      return true;
    }
  } catch (error) {
  }

  return false;
}

function enforceNationProtectionGamerules() {
  if (!getProtectedNationServerSlug()) {
    return;
  }

  tryRunWorldCommand('gamerule keepinventory true');
  tryRunWorldCommand('gamerule mobgriefing false');
  tryRunWorldCommand('gamerule tntexplodes false');
  tryRunWorldCommand('gamerule dofiretick false');
}

function toCenteredLocation(location, fallbackY = 80) {
  const x = Number(location?.x);
  const y = Number(location?.y);
  const z = Number(location?.z);

  return {
    x: Number.isFinite(x) ? Math.floor(x) + 0.5 : 0.5,
    y: Number.isFinite(y) ? y : fallbackY,
    z: Number.isFinite(z) ? Math.floor(z) + 0.5 : 0.5
  };
}

function resolveSurfaceLocation(dimension, location) {
  const centered = toCenteredLocation(location, 80);
  if (centered.y <= 1024) {
    return centered;
  }

  try {
    const topBlock = dimension.getTopmostBlock({
      x: Math.floor(centered.x),
      z: Math.floor(centered.z)
    });

    if (topBlock?.location) {
      return {
        x: Math.floor(centered.x) + 0.5,
        y: topBlock.location.y + 2,
        z: Math.floor(centered.z) + 0.5
      };
    }
  } catch (error) {
  }

  return {
    x: Math.floor(centered.x) + 0.5,
    y: 80,
    z: Math.floor(centered.z) + 0.5
  };
}

function getOverworldReturnTarget(player, preferredDimension, preferredLocation) {
  const overworld = world.getDimension('overworld');

  if (normalizeDimensionId(preferredDimension?.id) === 'overworld' && preferredLocation) {
    return {
      dimension: overworld,
      location: resolveSurfaceLocation(overworld, preferredLocation)
    };
  }

  try {
    const spawnPoint = player.getSpawnPoint?.();
    if (spawnPoint && normalizeDimensionId(spawnPoint.dimension?.id) === 'overworld') {
      return {
        dimension: overworld,
        location: resolveSurfaceLocation(overworld, spawnPoint)
      };
    }
  } catch (error) {
  }

  try {
    if (typeof world.getDefaultSpawnLocation === 'function') {
      return {
        dimension: overworld,
        location: resolveSurfaceLocation(overworld, world.getDefaultSpawnLocation())
      };
    }
  } catch (error) {
  }

  return {
    dimension: overworld,
    location: { x: 0.5, y: 80, z: 0.5 }
  };
}

function returnPlayerToOverworld(player, preferredDimension, preferredLocation) {
  const target = getOverworldReturnTarget(player, preferredDimension, preferredLocation);

  try {
    player.teleport(target.location, {
      checkForBlocks: true,
      dimension: target.dimension
    });
    return true;
  } catch (error) {
    try {
      player.teleport(target.location, {
        checkForBlocks: false,
        dimension: target.dimension
      });
      return true;
    } catch (nestedError) {
      return false;
    }
  }
}

function enforceCreativeAdmin(player, notify = false) {
  if (!isValidPlayer(player) || !isCreativeGamertag(player)) {
    return;
  }

  try {
    player.commandPermissionLevel = ADMIN_COMMAND_LEVEL;
  } catch (error) {
  }

  try {
    if (!isCreativeGameMode(player.getGameMode?.())) {
      player.setGameMode(CREATIVE_MODE);
      if (notify) {
        send(player, '\u00a7a[ADMIN] Seu modo criativo foi restaurado automaticamente.');
      }
    }
  } catch (error) {
    if (notify) {
      send(player, '\u00a7c[ADMIN] N\u00e3o foi poss\u00edvel restaurar seu modo criativo.');
    }
  }
}

function enforceProtectedNationMode(player, notify = false) {
  if (!isValidPlayer(player) || isCreativeGamertag(player) || !getProtectedNationServerSlug()) {
    return;
  }

  const accessType = getProtectedNationAccessType(player);

  if (accessType === 'visitor') {
    if (!isAdventureGameMode(player.getGameMode?.()) && trySetGameMode(player, ADVENTURE_MODE) && notify) {
      sendThrottled(
        player,
        'protected_nation_adventure',
        '\u00a7e[PROTECAO] Visitantes ficam em modo aventura dentro desta nacao.'
      );
    }
    return;
  }

  if (accessType === 'citizen') {
    if (!isAdventureGameMode(player.getGameMode?.()) && trySetGameMode(player, ADVENTURE_MODE) && notify) {
      sendThrottled(
        player,
        'protected_nation_citizen_adventure',
        '\u00a7e[PROTECAO] Cidadaos sem classe ficam em modo aventura ate serem promovidos.'
      );
    }
    return;
  }

  try {
    if (!isSurvivalGameMode(player.getGameMode?.()) && trySetGameMode(player, SURVIVAL_MODE) && notify) {
      sendThrottled(
        player,
        'protected_nation_survival',
        '\u00a7a[PROTECAO] Nativos desta nacao jogam em sobrevivencia aqui.'
      );
    }
  } catch (error) {
    if (notify) {
      send(player, '\u00a7c[NETWORK] N\u00e3o foi poss\u00edvel redefinir seu modo de jogo.');
    }
  }
}

function enforceSurvivalForNonAdmins(player, notify = false) {
  if (!isValidPlayer(player) || isCreativeGamertag(player)) {
    return;
  }

  if (!isSurvivalGameMode(player.getGameMode?.()) && trySetGameMode(player, SURVIVAL_MODE) && notify) {
    send(player, '\u00a7e[NETWORK] Seu modo de jogo foi redefinido para sobreviv\u00eancia.');
  }
}

function enforcePlayerModeRules(player, notify = false) {
  if (!isValidPlayer(player)) {
    return;
  }

  if (isCreativeGamertag(player)) {
    enforceCreativeAdmin(player, notify);
    return;
  }

  if (getProtectedNationServerSlug()) {
    enforceProtectedNationMode(player, notify);
    return;
  }

  enforceSurvivalForNonAdmins(player, notify);
}

function enforceDimensionRestrictions(player, preferredDimension, preferredLocation) {
  if (NETWORK_CONFIG.allowExtraDimensions || !isValidPlayer(player)) {
    return;
  }

  const currentDimensionId = normalizeDimensionId(player.dimension?.id);
  if (currentDimensionId !== 'nether' && currentDimensionId !== 'the_end') {
    return;
  }

  if (returnPlayerToOverworld(player, preferredDimension, preferredLocation)) {
    send(player, '\u00a7e[NETWORK] Nether e End est\u00e3o desativados neste mapa.');
  }
}

function cancelProtectedNationAction(eventPlayer, actionType, visitorKey, visitorMessage) {
  const accessType = getProtectedNationAccessType(eventPlayer);
  if (accessType === 'exempt') {
    return false;
  }

  if (accessType === 'visitor') {
    sendThrottled(eventPlayer, visitorKey, visitorMessage);
    return true;
  }

  if (accessType === 'citizen') {
    sendThrottled(
      eventPlayer,
      `citizen_${actionType}`,
      '\u00a7c[PROTECAO] Cidadaos so liberam a nacao depois de serem promovidos a construtor ou guerreiro.'
    );
    return true;
  }

  if (actionType === 'combat' && accessType === 'builder') {
    sendThrottled(
      eventPlayer,
      'builder_combat',
      '\u00a7c[PROTECAO] Construtores nao podem lutar no mapa da nacao.'
    );
    return true;
  }

  if (actionType === 'build' && accessType === 'warrior') {
    sendThrottled(
      eventPlayer,
      'warrior_build',
      '\u00a7c[PROTECAO] Guerreiros nao podem alterar blocos ou estruturas da nacao.'
    );
    return true;
  }

  if (actionType === 'interact_entity' && accessType === 'warrior') {
    sendThrottled(
      eventPlayer,
      'warrior_interact_entity',
      '\u00a7c[PROTECAO] Guerreiros nao podem interagir com entidades protegidas da nacao.'
    );
    return true;
  }

  return false;
}

function registerProtectedNationHooks() {
  if (!getProtectedNationServerSlug()) {
    return;
  }

  if (world.beforeEvents.entityHurt) {
    world.beforeEvents.entityHurt.subscribe((event) => {
      const attacker = event.damageSource?.damagingEntity;
      if (!isValidPlayer(attacker)) {
        return;
      }

      if (!cancelProtectedNationAction(attacker, 'combat', 'visitor_damage', '\u00a7c[PROTECAO] Visitantes nao podem causar dano nesta nacao.')) {
        return;
      }

      event.cancel = true;
    });
  }

  if (world.beforeEvents.playerBreakBlock) {
    world.beforeEvents.playerBreakBlock.subscribe((event) => {
      if (!cancelProtectedNationAction(event.player, 'build', 'visitor_break', '\u00a7c[PROTECAO] Visitantes nao podem quebrar blocos nesta nacao.')) {
        return;
      }

      event.cancel = true;
    });
  }

  if (world.beforeEvents.playerPlaceBlock) {
    world.beforeEvents.playerPlaceBlock.subscribe((event) => {
      if (!cancelProtectedNationAction(event.player, 'build', 'visitor_place', '\u00a7c[PROTECAO] Visitantes nao podem colocar blocos nesta nacao.')) {
        return;
      }

      event.cancel = true;
    });
  }

  if (world.beforeEvents.playerInteractWithBlock) {
    world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
      if (!cancelProtectedNationAction(event.player, 'interact_block', 'visitor_interact_block', '\u00a7c[PROTECAO] Visitantes nao podem interagir com blocos nesta nacao.')) {
        return;
      }

      event.cancel = true;
    });
  }

  if (world.beforeEvents.playerInteractWithEntity) {
    world.beforeEvents.playerInteractWithEntity.subscribe((event) => {
      if (!cancelProtectedNationAction(event.player, 'interact_entity', 'visitor_interact_entity', '\u00a7c[PROTECAO] Visitantes nao podem interagir com entidades nesta nacao.')) {
        return;
      }

      event.cancel = true;
    });
  }
}

export function initializeServerRules() {
  enforceNationProtectionGamerules();
  registerProtectedNationHooks();

  world.afterEvents.playerSpawn.subscribe((event) => {
    system.run(() => {
      const player = event.player;
      enforcePlayerModeRules(player);
      enforceDimensionRestrictions(player);
    });
  });

  if (world.afterEvents.playerGameModeChange) {
    world.afterEvents.playerGameModeChange.subscribe((event) => {
      system.run(() => {
        enforcePlayerModeRules(event.player, true);
      });
    });
  }

  if (world.afterEvents.playerDimensionChange) {
    world.afterEvents.playerDimensionChange.subscribe((event) => {
      if (NETWORK_CONFIG.allowExtraDimensions) {
        return;
      }

      const destinationDimensionId = normalizeDimensionId(event.toDimension?.id);
      if (destinationDimensionId !== 'nether' && destinationDimensionId !== 'the_end') {
        return;
      }

      system.run(() => {
        enforceDimensionRestrictions(event.player, event.fromDimension, event.fromLocation);
      });
    });
  }

  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      if (!isValidPlayer(player)) {
        continue;
      }

      enforcePlayerModeRules(player);
    }
  }, MODE_ENFORCEMENT_INTERVAL_TICKS);

  system.runInterval(() => {
    enforceNationProtectionGamerules();
  }, GAMERULE_REAPPLY_INTERVAL_TICKS);
}
