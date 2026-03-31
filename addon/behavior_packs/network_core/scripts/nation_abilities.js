import { ItemStack, system, world } from '@minecraft/server';
import { getCachedBundle } from './player_sync.js';

const PASSIVE_INTERVAL_TICKS = 20;
const COMBAT_WINDOW_MS = 8000;
const FEEDBACK_COOLDOWN_MS = 3000;
const STILL_HEAL_THRESHOLD_TICKS = 40;
const FLIGHT_DURATION_TICKS = 100;
const FLIGHT_FALLBACK_DURATION_TICKS = 120;

const recentCombatUntil = new Map();
const stillTicks = new Map();
const skillFeedbackUntil = new Map();
const flightUntil = new Map();

const NEGATIVE_EFFECTS = [
  'blindness',
  'darkness',
  'fatal_poison',
  'hunger',
  'levitation',
  'mining_fatigue',
  'nausea',
  'poison',
  'slowness',
  'weakness',
  'wither'
];

const WATER_IMMUNE_TYPES = new Set([
  'minecraft:drowned',
  'minecraft:elder_guardian',
  'minecraft:guardian',
  'minecraft:pufferfish'
]);

const FIRE_IMMUNE_TYPES = new Set([
  'minecraft:blaze',
  'minecraft:fireball',
  'minecraft:ghast',
  'minecraft:large_fireball',
  'minecraft:small_fireball'
]);

const FIRE_AUTO_SMELT = {
  'minecraft:ancient_debris': {
    rawTypeId: 'minecraft:ancient_debris',
    smeltedTypeId: 'minecraft:netherite_scrap'
  },
  'minecraft:copper_ore': {
    rawTypeId: 'minecraft:raw_copper',
    smeltedTypeId: 'minecraft:copper_ingot'
  },
  'minecraft:deepslate_copper_ore': {
    rawTypeId: 'minecraft:raw_copper',
    smeltedTypeId: 'minecraft:copper_ingot'
  },
  'minecraft:deepslate_gold_ore': {
    rawTypeId: 'minecraft:raw_gold',
    smeltedTypeId: 'minecraft:gold_ingot'
  },
  'minecraft:deepslate_iron_ore': {
    rawTypeId: 'minecraft:raw_iron',
    smeltedTypeId: 'minecraft:iron_ingot'
  },
  'minecraft:gold_ore': {
    rawTypeId: 'minecraft:raw_gold',
    smeltedTypeId: 'minecraft:gold_ingot'
  },
  'minecraft:iron_ore': {
    rawTypeId: 'minecraft:raw_iron',
    smeltedTypeId: 'minecraft:iron_ingot'
  }
};

const EARTH_DUPLICATION_BLOCKS = new Set([
  'minecraft:beetroot',
  'minecraft:birch_log',
  'minecraft:carrots',
  'minecraft:jungle_log',
  'minecraft:oak_log',
  'minecraft:potatoes',
  'minecraft:spruce_log',
  'minecraft:wheat'
]);

const EARTH_GEOLOGIST_BLOCKS = new Set([
  'minecraft:deepslate',
  'minecraft:stone'
]);

const FEEDBACK_MESSAGES = {
  air_dodge: '\u00a7e\u2728 ESQUIVA!',
  air_fall: '\u00a7e\u2728 LEVEZA!',
  air_flight: '\u00a7e\u2728 VOO!',
  air_gust: '\u00a7e\u2728 RAJADA!',
  earth_cleanse: '\u00a7a\ud83c\udf3f PUREZA!',
  earth_geo: '\u00a7a\ud83c\udf3f GE\u00d3LOGO!',
  earth_harvest: '\u00a7a\ud83c\udf3f COLHEITA!',
  earth_meditation: '\u00a7a\ud83c\udf3f MEDITA\u00c7\u00c3O!',
  earth_root: '\u00a7a\ud83c\udf3f RA\u00cdZES!',
  fire_breath: '\u00a7c\ud83d\udd25 SOPRO FINAL!',
  fire_berserker: '\u00a7c\ud83d\udd25 BERSERKER!',
  fire_ignite: '\u00a7c\ud83d\udd25 INCENDIAR!',
  fire_smelting: '\u00a7c\ud83d\udd25 FORJA!',
  water_guard: '\u00a79\ud83d\udee1\ufe0f GUARDA!',
  water_harpoon: '\u00a79\ud83d\udd31 ARP\u00c3O!',
  water_loot: '\u00a79\ud83d\udca7 COLETOR!'
};

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isValidPlayer(player) {
  try {
    if (!player) {
      return false;
    }

    if (typeof player.isValid === 'function') {
      return player.isValid();
    }

    return player.isValid !== false;
  } catch (error) {
    return false;
  }
}

function getPlayerBundle(player) {
  return getCachedBundle(player) || null;
}

function getNationKey(player) {
  return normalizeText(getPlayerBundle(player)?.profile?.nationSlug);
}

function getRoleKey(player) {
  const className = normalizeText(getPlayerBundle(player)?.profile?.className);
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

function isWaterPlayer(player) {
  try {
    if (typeof player.isInWater === 'boolean') {
      return player.isInWater;
    }
  } catch (error) {
  }

  try {
    if (typeof player.isSwimming === 'boolean' && player.isSwimming) {
      return true;
    }
  } catch (error) {
  }

  try {
    const sampleOffsets = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0.6, z: 0 },
      { x: 0, y: 1.2, z: 0 },
      { x: 0.3, y: 0.6, z: 0 },
      { x: -0.3, y: 0.6, z: 0 },
      { x: 0, y: 0.6, z: 0.3 },
      { x: 0, y: 0.6, z: -0.3 }
    ];

    for (const offset of sampleOffsets) {
      const block = player.dimension.getBlock({
        x: Math.floor(player.location.x + offset.x),
        y: Math.floor(player.location.y + offset.y),
        z: Math.floor(player.location.z + offset.z)
      });
      const typeId = String(block?.typeId || '');
      if (typeId.includes('water') || typeId.includes('bubble_column')) {
        return true;
      }
    }
  } catch (error) {
  }

  return false;
}

function showFeedback(player, skillKey) {
  if (!isValidPlayer(player)) {
    return;
  }

  const message = FEEDBACK_MESSAGES[skillKey];
  if (!message) {
    return;
  }

  const stateKey = `${player.id}:${skillKey}`;
  const now = Date.now();
  const nextAllowed = skillFeedbackUntil.get(stateKey) || 0;
  if (now < nextAllowed) {
    return;
  }

  skillFeedbackUntil.set(stateKey, now + FEEDBACK_COOLDOWN_MS);

  try {
    player.onScreenDisplay.setActionBar(message);
  } catch (error) {
  }
}

function safeAddEffect(player, effectType, duration, amplifier = 0) {
  try {
    player.addEffect(effectType, duration, {
      amplifier,
      showParticles: false
    });
  } catch (error) {
  }
}

function safeRemoveEffect(player, effectType) {
  try {
    player.removeEffect(effectType);
    return true;
  } catch (error) {
    return false;
  }
}

function trackCombat(entity) {
  if (!isValidPlayer(entity)) {
    return;
  }

  recentCombatUntil.set(entity.id, Date.now() + COMBAT_WINDOW_MS);
}

function isInCombat(player) {
  return (recentCombatUntil.get(player.id) || 0) > Date.now();
}

function isPlayerEntity(entity) {
  return entity?.typeId === 'minecraft:player';
}

function isFireCause(cause) {
  const normalized = normalizeText(cause);
  return [
    'contact',
    'fire',
    'firetick',
    'fire_tick',
    'lava',
    'lavatick',
    'lava_tick',
    'magma',
    'magma_block',
    'magmablock'
  ].includes(normalized);
}

function isDrowningCause(cause) {
  const normalized = normalizeText(cause);
  return normalized === 'drown' || normalized === 'drowning';
}

function isFallCause(cause) {
  return normalizeText(cause) === 'fall';
}

function applyKnockbackAway(attacker, victim, horizontalStrength, verticalStrength) {
  try {
    const dx = victim.location.x - attacker.location.x;
    const dz = victim.location.z - attacker.location.z;
    const magnitude = Math.sqrt(dx * dx + dz * dz);

    if (magnitude <= 0.01) {
      return;
    }

    victim.applyKnockback(dx / magnitude, dz / magnitude, horizontalStrength, verticalStrength);
  } catch (error) {
  }
}

function pullVictimToward(attacker, victim, horizontalStrength, verticalStrength) {
  try {
    const dx = attacker.location.x - victim.location.x;
    const dz = attacker.location.z - victim.location.z;
    const magnitude = Math.sqrt(dx * dx + dz * dz);

    if (magnitude <= 0.01) {
      return;
    }

    victim.applyKnockback(dx / magnitude, dz / magnitude, horizontalStrength, verticalStrength);
  } catch (error) {
  }
}

function distance(a, b) {
  const dx = Number(a?.x || 0) - Number(b?.x || 0);
  const dy = Number(a?.y || 0) - Number(b?.y || 0);
  const dz = Number(a?.z || 0) - Number(b?.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function duplicateNearbyDrops(dimension, location, chance, skillKey) {
  system.runTimeout(() => {
    try {
      const items = dimension.getEntities({
        location,
        maxDistance: 2.5
      });

      const duplicatedTypes = new Set();
      for (const entity of items) {
        if (entity?.typeId !== 'minecraft:item') {
          continue;
        }

        const itemComponent = entity.getComponent('minecraft:item');
        const itemStack = itemComponent?.itemStack;
        if (!itemStack?.typeId || duplicatedTypes.has(itemStack.typeId) || Math.random() >= chance) {
          continue;
        }

        duplicatedTypes.add(itemStack.typeId);
        dimension.spawnItem(
          new ItemStack(itemStack.typeId, Math.max(1, Number(itemStack.amount || 1))),
          {
            x: location.x + 0.5,
            y: location.y + 0.5,
            z: location.z + 0.5
          }
        );
      }

      if (duplicatedTypes.size > 0) {
        const nearbyPlayer = world
          .getAllPlayers()
          .find((player) => player.dimension.id === dimension.id && distance(player.location, location) <= 8);
        if (nearbyPlayer) {
          showFeedback(nearbyPlayer, skillKey);
        }
      }
    } catch (error) {
    }
  }, 2);
}

function transformNearbyDrops(dimension, location, rawTypeId, smeltedTypeId, bonusChance, player) {
  system.runTimeout(() => {
    try {
      const items = dimension.getEntities({
        location,
        maxDistance: 2.5
      });

      let converted = false;
      for (const entity of items) {
        if (entity?.typeId !== 'minecraft:item') {
          continue;
        }

        const itemComponent = entity.getComponent('minecraft:item');
        const itemStack = itemComponent?.itemStack;
        if (!itemStack?.typeId || itemStack.typeId !== rawTypeId) {
          continue;
        }

        const baseAmount = Math.max(1, Number(itemStack.amount || 1));
        const bonusAmount = Math.random() < bonusChance ? baseAmount : 0;

        entity.remove();
        dimension.spawnItem(
          new ItemStack(smeltedTypeId, baseAmount + bonusAmount),
          {
            x: location.x + 0.5,
            y: location.y + 0.5,
            z: location.z + 0.5
          }
        );
        converted = true;
      }

      if (converted) {
        showFeedback(player, 'fire_smelting');
      }
    } catch (error) {
    }
  }, 2);
}

function collectNearbyDrops(player, location) {
  system.runTimeout(() => {
    try {
      const items = player.dimension.getEntities({
        location,
        maxDistance: 3
      });

      let collected = false;
      for (const entity of items) {
        if (entity?.typeId !== 'minecraft:item') {
          continue;
        }

        entity.teleport({
          x: player.location.x,
          y: player.location.y + 0.5,
          z: player.location.z
        });
        collected = true;
      }

      if (collected) {
        showFeedback(player, 'water_loot');
      }
    } catch (error) {
    }
  }, 2);
}

function tryRunPlayerCommand(player, command) {
  try {
    if (typeof player.runCommandAsync === 'function') {
      player.runCommandAsync(command).catch(() => {});
      return true;
    }
  } catch (error) {
  }

  try {
    if (typeof player.runCommand === 'function') {
      player.runCommand(command);
      return true;
    }
  } catch (error) {
  }

  return false;
}

function setTemporaryFlight(player, enabled) {
  if (!isValidPlayer(player)) {
    return;
  }

  if (!tryRunPlayerCommand(player, `ability @s mayfly ${enabled ? 'true' : 'false'}`) && enabled) {
    safeAddEffect(player, 'jump_boost', FLIGHT_FALLBACK_DURATION_TICKS, 1);
    safeAddEffect(player, 'slow_falling', FLIGHT_FALLBACK_DURATION_TICKS, 0);
  }
}

function triggerBuilderFlight(player) {
  if (!isValidPlayer(player)) {
    return;
  }

  flightUntil.set(player.id, Date.now() + FLIGHT_DURATION_TICKS * 50);
  setTemporaryFlight(player, true);
  safeAddEffect(player, 'slow_falling', FLIGHT_FALLBACK_DURATION_TICKS, 0);
  safeAddEffect(player, 'jump_boost', FLIGHT_FALLBACK_DURATION_TICKS, 1);
  showFeedback(player, 'air_flight');
}

function handlePassiveAbilities(player) {
  const nationKey = getNationKey(player);
  if (!nationKey) {
    return;
  }

  const roleKey = getRoleKey(player);
  const inWater = isWaterPlayer(player);

  switch (nationKey) {
    case 'fire':
      safeAddEffect(player, 'fire_resistance', 80, 0);
      if (player.dimension?.id === 'minecraft:nether') {
        safeAddEffect(player, 'speed', 80, 1);
        safeAddEffect(player, 'strength', 80, 0);
      }
      if (roleKey === 'builder') {
        safeAddEffect(player, 'haste', 80, 1);
      }
      break;
    case 'water':
      if (inWater) {
        safeAddEffect(player, 'water_breathing', 80, 0);
        safeAddEffect(player, 'night_vision', 80, 0);
        safeAddEffect(player, 'conduit_power', 80, 0);
        safeAddEffect(player, 'dolphins_grace', 80, 2);
        safeAddEffect(player, 'speed', 80, 1);
      }
      if (roleKey === 'warrior' && inWater) {
        safeAddEffect(player, 'speed', 80, 5);
        safeAddEffect(player, 'strength', 80, 1);
      }
      if (roleKey === 'builder' && inWater) {
        safeAddEffect(player, 'haste', 80, 3);
      }
      break;
    case 'earth': {
      safeAddEffect(player, 'night_vision', 160, 0);

      let removedNegativeEffect = false;
      for (const effectType of NEGATIVE_EFFECTS) {
        removedNegativeEffect = safeRemoveEffect(player, effectType) || removedNegativeEffect;
      }
      if (removedNegativeEffect) {
        showFeedback(player, 'earth_cleanse');
      }

      if (roleKey === 'warrior') {
        const velocity = player.getVelocity?.();
        const isStandingStill =
          Math.abs(Number(velocity?.x || 0)) < 0.02 &&
          Math.abs(Number(velocity?.y || 0)) < 0.02 &&
          Math.abs(Number(velocity?.z || 0)) < 0.02;

        if (isStandingStill) {
          const ticks = (stillTicks.get(player.id) || 0) + PASSIVE_INTERVAL_TICKS;
          stillTicks.set(player.id, ticks);

          if (ticks >= STILL_HEAL_THRESHOLD_TICKS) {
            const health = player.getComponent('minecraft:health');
            if (health && health.currentValue < health.effectiveMax) {
              try {
                health.setCurrentValue(Math.min(health.currentValue + 2, health.effectiveMax));
                showFeedback(player, 'earth_meditation');
              } catch (error) {
              }
            }
          }
        } else {
          stillTicks.delete(player.id);
        }
      }

      if (roleKey === 'builder' && Number(player.location?.y ?? 256) < 60) {
        safeAddEffect(player, 'haste', 80, 2);
      }
      break;
    }
    case 'air':
      safeAddEffect(player, 'speed', 80, 0);
      if (roleKey === 'warrior' && isInCombat(player)) {
        safeAddEffect(player, 'speed', 80, 1);
        safeAddEffect(player, 'jump_boost', 80, 1);
      }
      if (roleKey === 'builder') {
        safeAddEffect(player, 'haste', 80, 2);
      }
      break;
    default:
      break;
  }
}

function registerCombatHooks() {
  if (world.afterEvents.entityHitEntity) {
    world.afterEvents.entityHitEntity.subscribe((event) => {
      trackCombat(event.damagingEntity);
      trackCombat(event.hitEntity);

      const attacker = event.damagingEntity;
      const victim = event.hitEntity;

      if (!isPlayerEntity(attacker)) {
        return;
      }

      if (getNationKey(attacker) !== 'air' || getRoleKey(attacker) !== 'warrior' || Math.random() >= 0.35) {
        return;
      }

      system.run(() => {
        applyKnockbackAway(attacker, victim, 7.5, 1.8);
        showFeedback(attacker, 'air_gust');
      });
    });
  }

  if (world.afterEvents.entityHurt) {
    world.afterEvents.entityHurt.subscribe((event) => {
      trackCombat(event.hurtEntity);
      trackCombat(event.damageSource?.damagingEntity);

      if (isPlayerEntity(event.hurtEntity)) {
        stillTicks.delete(event.hurtEntity.id);
      }
    });
  }

  if (!world.beforeEvents.entityHurt) {
    return;
  }

  world.beforeEvents.entityHurt.subscribe((event) => {
    const victim = event.hurtEntity;
    const attacker = event.damageSource?.damagingEntity;
    const cause = event.damageSource?.cause;

    if (isPlayerEntity(victim)) {
      const victimNation = getNationKey(victim);
      const victimRole = getRoleKey(victim);

      if (victimNation === 'fire' && (isFireCause(cause) || FIRE_IMMUNE_TYPES.has(attacker?.typeId))) {
        event.cancel = true;
        return;
      }

      if (victimNation === 'water' && (isDrowningCause(cause) || WATER_IMMUNE_TYPES.has(attacker?.typeId))) {
        event.cancel = true;
        showFeedback(victim, 'water_guard');
        return;
      }

      if (victimNation === 'air' && isFallCause(cause)) {
        event.cancel = true;
        showFeedback(victim, 'air_fall');
        return;
      }

      if (victimNation === 'earth' && victimRole === 'warrior' && isPlayerEntity(attacker)) {
        event.damage = Number(event.damage || 0) * 0.3;
      }

      if (victimNation === 'air' && victimRole === 'warrior' && Math.random() < 0.3) {
        event.cancel = true;
        showFeedback(victim, 'air_dodge');
        return;
      }

      if (victimNation === 'fire' && victimRole === 'warrior') {
        const health = victim.getComponent('minecraft:health');
        const currentHealth = Number(health?.currentValue ?? 20);
        const projectedHealth = currentHealth - Number(event.damage || 0);

        if (projectedHealth <= 1 && Math.random() < 0.3) {
          const location = {
            x: victim.location.x,
            y: victim.location.y,
            z: victim.location.z
          };
          const dimension = victim.dimension;

          system.run(() => {
            try {
              dimension.createExplosion(location, 3.5, {
                breaksBlocks: false,
                causesFire: true
              });
              showFeedback(victim, 'fire_breath');
            } catch (error) {
            }
          });
        }
      }
    }

    if (!isPlayerEntity(attacker)) {
      return;
    }

    const attackerNation = getNationKey(attacker);
    const attackerRole = getRoleKey(attacker);
    if (attackerRole !== 'warrior') {
      return;
    }

    if (attackerNation === 'fire') {
      let multiplier = 1;
      if (isPlayerEntity(victim)) {
        multiplier += 0.4;
      }

      const health = attacker.getComponent('minecraft:health');
      const missingHearts = Math.max(
        0,
        Math.floor((Number(health?.effectiveMax ?? 20) - Number(health?.currentValue ?? 20)) / 2)
      );
      if (missingHearts > 0) {
        multiplier += missingHearts * 0.1;
        system.run(() => {
          showFeedback(attacker, 'fire_berserker');
        });
      }

      event.damage = Number(event.damage || 0) * multiplier;

      if (Math.random() < 0.3) {
        system.run(() => {
          try {
            victim.setOnFire(5, true);
            showFeedback(attacker, 'fire_ignite');
          } catch (error) {
          }
        });
      }
      return;
    }

    if (attackerNation === 'water' && Math.random() < 0.25) {
      system.run(() => {
        pullVictimToward(attacker, victim, 4, 1);
        showFeedback(attacker, 'water_harpoon');
      });
      return;
    }

    if (attackerNation === 'earth' && Math.random() < 0.25) {
      system.run(() => {
        try {
          victim.addEffect('slowness', 60, {
            amplifier: 3,
            showParticles: true
          });
          showFeedback(attacker, 'earth_root');
        } catch (error) {
        }
      });
      return;
    }

  });
}

function registerBuilderHooks() {
  if (world.beforeEvents.playerBreakBlock) {
    world.beforeEvents.playerBreakBlock.subscribe((event) => {
      const player = event.player;
      if (!isValidPlayer(player)) {
        return;
      }

      const nationKey = getNationKey(player);
      const roleKey = getRoleKey(player);
      if (roleKey !== 'builder') {
        return;
      }

      const block = event.block;
      const location = {
        x: block.location.x,
        y: block.location.y,
        z: block.location.z
      };

      if (nationKey === 'fire') {
        const smeltEntry = FIRE_AUTO_SMELT[block.typeId];
        if (smeltEntry) {
          transformNearbyDrops(
            player.dimension,
            location,
            smeltEntry.rawTypeId,
            smeltEntry.smeltedTypeId,
            0.1,
            player
          );
        }
        return;
      }

      if (nationKey === 'water') {
        collectNearbyDrops(player, location);
        return;
      }

      if (nationKey === 'earth') {
        if (EARTH_DUPLICATION_BLOCKS.has(block.typeId)) {
          duplicateNearbyDrops(player.dimension, location, 0.1, 'earth_harvest');
        }

        if (EARTH_GEOLOGIST_BLOCKS.has(block.typeId)) {
          system.runTimeout(() => {
            try {
              const chance = Math.random();
              let dropTypeId = null;

              if (chance < 0.005) {
                dropTypeId = 'minecraft:diamond';
              } else if (chance < 0.02) {
                dropTypeId = 'minecraft:raw_iron';
              } else if (chance < 0.05) {
                dropTypeId = 'minecraft:coal';
              }

              if (!dropTypeId) {
                return;
              }

              player.dimension.spawnItem(
                new ItemStack(dropTypeId, 1),
                {
                  x: location.x + 0.5,
                  y: location.y + 0.5,
                  z: location.z + 0.5
                }
              );
              showFeedback(player, 'earth_geo');
            } catch (error) {
            }
          }, 2);
        }
        return;
      }

      if (nationKey === 'air') {
        triggerBuilderFlight(player);
      }
    });
  }

  if (world.beforeEvents.playerPlaceBlock) {
    world.beforeEvents.playerPlaceBlock.subscribe((event) => {
      const player = event.player;
      if (!isValidPlayer(player)) {
        return;
      }

      if (getNationKey(player) === 'air' && getRoleKey(player) === 'builder') {
        triggerBuilderFlight(player);
      }
    });
  }
}

function registerPassiveLoop() {
  system.runInterval(() => {
    for (const player of world.getAllPlayers()) {
      if (!isValidPlayer(player)) {
        continue;
      }

      handlePassiveAbilities(player);
    }
  }, PASSIVE_INTERVAL_TICKS);

  system.runInterval(() => {
    const now = Date.now();
    for (const player of world.getAllPlayers()) {
      if (!isValidPlayer(player)) {
        continue;
      }

      const expiresAt = flightUntil.get(player.id);
      if (!expiresAt) {
        continue;
      }

      if (now < expiresAt) {
        setTemporaryFlight(player, true);
        continue;
      }

      flightUntil.delete(player.id);
      setTemporaryFlight(player, false);
    }
  }, 10);
}

let initialized = false;

export function initializeNationAbilities() {
  if (initialized) {
    return;
  }

  initialized = true;
  registerCombatHooks();
  registerBuilderHooks();
  registerPassiveLoop();
}
