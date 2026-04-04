import { CommandPermissionLevel, GameMode, system, world } from '@minecraft/server';
import { NETWORK_CONFIG } from './config.js';

const CREATIVE_MODE = GameMode.Creative ?? GameMode.creative ?? 'creative';
const SURVIVAL_MODE = GameMode.Survival ?? GameMode.survival ?? 'survival';
const ADMIN_COMMAND_LEVEL =
  CommandPermissionLevel.Admin ?? CommandPermissionLevel.GameDirectors ?? 2;

const adminGamertags = new Set(
  NETWORK_CONFIG.adminCreativeGamertags.map((entry) => normalizeName(entry))
);

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
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

function enforceSurvivalForNonAdmins(player, notify = false) {
  if (!isValidPlayer(player) || isCreativeGamertag(player)) {
    return;
  }

  try {
    if (!isSurvivalGameMode(player.getGameMode?.())) {
      player.setGameMode(SURVIVAL_MODE);
      if (notify) {
        send(player, '\u00a7e[NETWORK] Seu modo de jogo foi redefinido para sobreviv\u00eancia.');
      }
    }
  } catch (error) {
    if (notify) {
      send(player, '\u00a7c[NETWORK] N\u00e3o foi poss\u00edvel redefinir seu modo de jogo.');
    }
  }
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

export function initializeServerRules() {
  world.afterEvents.playerSpawn.subscribe((event) => {
    system.run(() => {
      const player = event.player;
      enforceCreativeAdmin(player);
      enforceSurvivalForNonAdmins(player);
      enforceDimensionRestrictions(player);
    });
  });

  if (world.afterEvents.playerGameModeChange) {
    world.afterEvents.playerGameModeChange.subscribe((event) => {
      system.run(() => {
        if (isCreativeGamertag(event.player)) {
          if (!isCreativeGameMode(event.toGameMode)) {
            enforceCreativeAdmin(event.player, true);
          }
          return;
        }

        if (isCreativeGameMode(event.toGameMode)) {
          enforceSurvivalForNonAdmins(event.player, true);
        }
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
}
