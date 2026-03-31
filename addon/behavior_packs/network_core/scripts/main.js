import { system, world } from '@minecraft/server';
import { beforeEvents as adminBeforeEvents } from '@minecraft/server-admin';
import { ActionFormData } from '@minecraft/server-ui';
import { NETWORK_CONFIG } from './config.js';
import {
  chooseNation,
  connectPlayer,
  demoteNationMember,
  disconnectPlayer,
  expelNationMember,
  getCachedBundle,
  getTopRicos,
  mintBalance,
  promoteNationMember,
  reloadPlayerBundle,
  rememberPersistentIdentity,
  savePlayerState,
  setCachedBalance,
  transferBalance
} from './player_sync.js';
import { initializeNationAbilities } from './nation_abilities.js';
import { initializeServerRules } from './server_rules.js';
import { maybeHandleTransferCommand } from './server_transfer.js';

function send(player, message) {
  try {
    player.sendMessage(message);
  } catch (error) {
  }
}

function debugNationSelection(message) {
  try {
    console.warn(`[NATION_UI] ${message}`);
  } catch (error) {
  }
}

function isPlayerValid(player) {
  if (!player) {
    return false;
  }

  try {
    if (typeof player.isValid === 'function') {
      return Boolean(player.isValid());
    }

    if (typeof player.isValid === 'boolean') {
      return player.isValid;
    }
  } catch (error) {
    return false;
  }

  return true;
}

function readProfileValue(value, fallback) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function formatDracoBalance(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) {
    return '0 dracos';
  }

  return `${Math.trunc(amount)} dracos`;
}

function parsePayCommand(rawMessage) {
  const trimmed = String(rawMessage || '').trim();
  const match = trimmed.match(/^!pagar\s+(.+)\s+(-?\d+)$/i);

  if (!match) {
    return null;
  }

  let targetGamertag = String(match[1] || '').trim();
  const amount = Number(match[2]);

  if (
    (targetGamertag.startsWith('"') && targetGamertag.endsWith('"')) ||
    (targetGamertag.startsWith("'") && targetGamertag.endsWith("'"))
  ) {
    targetGamertag = targetGamertag.slice(1, -1).trim();
  }

  return {
    targetGamertag,
    amount
  };
}

function parseMintCommand(rawMessage) {
  const trimmed = String(rawMessage || '').trim();
  const match = trimmed.match(/^!mint\s+(.+)\s+(-?\d+)$/i);

  if (!match) {
    return null;
  }

  let targetGamertag = String(match[1] || '').trim();
  const amount = Number(match[2]);

  if (
    (targetGamertag.startsWith('"') && targetGamertag.endsWith('"')) ||
    (targetGamertag.startsWith("'") && targetGamertag.endsWith("'"))
  ) {
    targetGamertag = targetGamertag.slice(1, -1).trim();
  }

  return {
    targetGamertag,
    amount
  };
}

function findOnlinePlayerByGamertag(targetGamertag) {
  const normalizedTarget = String(targetGamertag || '').trim().toLowerCase();
  if (!normalizedTarget) {
    return null;
  }

  return (
    world
      .getAllPlayers()
      .find((candidate) => String(candidate?.name || '').trim().toLowerCase() === normalizedTarget) || null
  );
}

const NATION_ALIAS_TO_SLUG = new Map([
  ['agua', 'water'],
  ['air', 'air'],
  ['ar', 'air'],
  ['earth', 'earth'],
  ['fire', 'fire'],
  ['fogo', 'fire'],
  ['terra', 'earth'],
  ['vento', 'air'],
  ['water', 'water']
]);

const NATION_COMMAND_ALIAS = {
  air: '!vento',
  earth: '!terra',
  fire: '!fogo',
  water: '!agua'
};

const NATION_DISPLAY_NAME = {
  air: 'Nacao do Vento',
  earth: 'Nacao da Terra',
  fire: 'Nacao do Fogo',
  water: 'Nacao da Agua'
};

const NATION_SELECTION_OPTIONS = [
  {
    slug: 'fire',
    name: 'Nacao do Fogo',
    summary: 'Forca bruta, fogo e agressividade.',
    command: '!fogo'
  },
  {
    slug: 'water',
    name: 'Nacao da Agua',
    summary: 'Mobilidade aquatica e dominio do mar.',
    command: '!agua'
  },
  {
    slug: 'earth',
    name: 'Nacao da Terra',
    summary: 'Defesa, controle de terreno e mineracao.',
    command: '!terra'
  },
  {
    slug: 'air',
    name: 'Nacao do Vento',
    summary: 'Velocidade, esquiva e mobilidade extrema.',
    command: '!vento'
  }
];

const nationSelectionCooldownUntil = new Map();
const nationSelectionPending = new Set();
const activeNationMenus = new Map();

const PROMOTION_CLASS_ALIASES = [
  'cacador',
  'cacador do ceu',
  'construtor',
  'engenheiro',
  'engenheiro de nuvens',
  'espada',
  'fornalha',
  'geologo',
  'geologo da terra',
  'guardiao',
  'guardiao da floresta',
  'guerreiro',
  'lamina',
  'lamina de labareda',
  'lanca',
  'mare',
  'mares',
  'martelo',
  'mestre da fornalha',
  'mestre das mares',
  'picareta',
  'tridente',
  'tritao',
  'tritao de combate'
]
  .map((entry) => normalizeCommandText(entry))
  .sort((left, right) => right.split(' ').length - left.split(' ').length);

function normalizeCommandText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function stripOuterQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function resolveNationSlug(value) {
  return NATION_ALIAS_TO_SLUG.get(normalizeCommandText(value)) || null;
}

function parseNationChoiceCommand(rawMessage) {
  const match = String(rawMessage || '').trim().match(/^!nacao\s+(.+)$/i);
  if (!match) {
    return null;
  }

  return resolveNationSlug(stripOuterQuotes(match[1]));
}

function parseSingleTargetCommand(rawMessage, commandKeyword) {
  const match = String(rawMessage || '').trim().match(new RegExp(`^!${commandKeyword}\\s+(.+)$`, 'i'));
  if (!match) {
    return null;
  }

  const targetGamertag = stripOuterQuotes(match[1]);
  if (!targetGamertag) {
    return null;
  }

  return {
    targetGamertag
  };
}

function parsePromoteCommand(rawMessage) {
  const trimmed = String(rawMessage || '').trim();
  const rest = trimmed.replace(/^!promover\s+/i, '').trim();
  if (!rest) {
    return null;
  }

  const quotedTargetMatch = rest.match(/^("(?:[^"]+)"|'(?:[^']+)')\s+(.+)$/);
  if (quotedTargetMatch) {
    const targetGamertag = stripOuterQuotes(quotedTargetMatch[1]);
    const className = stripOuterQuotes(quotedTargetMatch[2]);
    if (targetGamertag && className) {
      return {
        targetGamertag,
        className
      };
    }
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return null;
  }

  for (const alias of PROMOTION_CLASS_ALIASES) {
    const aliasTokens = alias.split(' ');
    if (aliasTokens.length >= tokens.length) {
      continue;
    }

    const classTokens = tokens.slice(-aliasTokens.length);
    if (normalizeCommandText(classTokens.join(' ')) !== alias) {
      continue;
    }

    const targetGamertag = stripOuterQuotes(tokens.slice(0, -aliasTokens.length).join(' '));
    const className = stripOuterQuotes(classTokens.join(' '));
    if (!targetGamertag || !className) {
      continue;
    }

    return {
      targetGamertag,
      className
    };
  }

  return null;
}

function sendNationSelectionHint(player) {
  send(
    player,
    '\u00a7e[NACAO] Voce ainda nao escolheu uma nacao. Use \u00a7f!nacoes\u00a7e para abrir a selecao ou \u00a7f!nacao fogo|agua|terra|vento\u00a7e.'
  );
}

function queueNationSelection(player) {
  if (!isPlayerValid(player)) {
    return;
  }

  nationSelectionPending.add(player.id);
  debugNationSelection(`queue:${player.name}`);

  try {
    player.addEffect('resistance', 999999, {
      amplifier: 255,
      showParticles: false
    });
  } catch (error) {
  }

  try {
    player.addEffect('slowness', 40, {
      amplifier: 2,
      showParticles: false
    });
  } catch (error) {
  }
}

function clearNationSelection(player) {
  if (!player?.id) {
    return;
  }

  nationSelectionPending.delete(player.id);
  clearActiveNationMenu(player);
  debugNationSelection(`clear:${player.name}`);

  try {
    player.removeEffect('resistance');
  } catch (error) {
  }

  try {
    player.removeEffect('slowness');
  } catch (error) {
  }
}

async function refreshOnlinePlayerBundle(targetGamertag) {
  const targetPlayer = findOnlinePlayerByGamertag(targetGamertag);
  if (!targetPlayer) {
    return null;
  }

  const refresh = await reloadPlayerBundle(targetPlayer);
  return {
    player: targetPlayer,
    refresh
  };
}

function canOpenNationSelection(player) {
  const nextAllowed = nationSelectionCooldownUntil.get(player.id) || 0;
  return Date.now() >= nextAllowed;
}

function markNationSelectionOpen(player, cooldownMs = 4000) {
  nationSelectionCooldownUntil.set(player.id, Date.now() + cooldownMs);
}

function hasActiveNationMenu(player, staleMs = 15000) {
  const startedAt = activeNationMenus.get(player?.id) || 0;
  if (!startedAt) {
    return false;
  }

  if (Date.now() - startedAt > staleMs) {
    activeNationMenus.delete(player.id);
    return false;
  }

  return true;
}

function markActiveNationMenu(player) {
  if (!player?.id) {
    return;
  }

  activeNationMenus.set(player.id, Date.now());
}

function clearActiveNationMenu(player) {
  if (!player?.id) {
    return;
  }

  activeNationMenus.delete(player.id);
}

async function finalizeNationSelection(player, selectedOption) {
  const result = await chooseNation(player, selectedOption.slug);
  if (!result.ok) {
    switch (result.error) {
      case 'nation_already_selected':
        send(player, '\u00a7c[NACAO] Voce ja escolheu uma nacao para este personagem.');
        break;
      case 'nation_not_found':
        send(player, '\u00a7c[NACAO] A nacao informada nao existe.');
        break;
      default:
        send(player, `\u00a7c[NACAO] Falha ao escolher nacao: ${result.error}`);
        break;
    }
    return;
  }

  const travelCommand = NATION_COMMAND_ALIAS[result.nationSlug] || selectedOption.command || '!mapas';
  const nationDisplayName =
    result.nationName || NATION_DISPLAY_NAME[result.nationSlug] || selectedOption.name || result.nationSlug;
  clearNationSelection(player);
  send(player, `\u00a7a[NACAO] Voce agora pertence a \u00a7b${nationDisplayName}\u00a7a.`);
  send(player, `\u00a77Para viajar ao seu mapa, use \u00a7f${travelCommand}\u00a77.`);
  send(player, '\u00a77Depois disso, um lord pode usar \u00a7f!promover Seu Nome Classe\u00a77 para definir sua classe.');
}

async function openNationSelectionForm(player, options = {}) {
  const {
    force = false,
    retryCount = 0,
    retryDelayTicks = 20,
    silentRetry = false
  } = options;
  if (!isPlayerValid(player)) {
    return;
  }

  const cachedBundle = getCachedBundle(player);
  const currentNationSlug = String(cachedBundle?.profile?.nationSlug || '').trim();
  if (currentNationSlug) {
    clearNationSelection(player);
    send(
      player,
      `\u00a7e[NACAO] Voce ja pertence a \u00a7b${readProfileValue(
        cachedBundle?.profile?.nationName,
        NATION_DISPLAY_NAME[currentNationSlug] || currentNationSlug
      )}\u00a7e.`
    );
    return;
  }

  if (hasActiveNationMenu(player)) {
    debugNationSelection(`show:active:${player.name}`);
    return;
  }

  if (!force && !canOpenNationSelection(player)) {
    debugNationSelection(`cooldown:${player.name}`);
    return;
  }

  markActiveNationMenu(player);
  markNationSelectionOpen(player);
  debugNationSelection(`show:start:${player.name}:force=${force}:retry=${retryCount}`);

  const form = new ActionFormData()
    .title('Escolha sua nacao')
    .body('Seu personagem ainda nao pertence a nenhuma nacao.\n\nEscolha abaixo o caminho inicial da sua jornada.');

  for (const option of NATION_SELECTION_OPTIONS) {
    form.button(`${option.name}\n${option.summary}`);
  }

  try {
    const selectionResult = await form.show(player);
    clearActiveNationMenu(player);

    if (!isPlayerValid(player)) {
      debugNationSelection(`show:invalid:${player?.name || 'unknown'}`);
      return;
    }

    if (selectionResult?.canceled) {
      debugNationSelection(`show:canceled:${player.name}:retry=${retryCount}`);
      if (retryCount > 0 || nationSelectionPending.has(player.id)) {
        system.runTimeout(() => {
          void openNationSelectionForm(player, {
            force: true,
            retryCount: Math.max(retryCount - 1, 0),
            retryDelayTicks,
            silentRetry: true
          });
        }, retryDelayTicks);
        return;
      }

      if (force) {
        send(player, '\u00a7e[NACAO] A selecao foi cancelada. Feche o chat e use \u00a7f!nacoes\u00a7e novamente.');
      }
      return;
    }

    const selectedOption = NATION_SELECTION_OPTIONS[Number(selectionResult?.selection)];
    if (!selectedOption) {
      debugNationSelection(`show:empty-selection:${player.name}`);
      sendNationSelectionHint(player);
      return;
    }

    debugNationSelection(`show:selected:${player.name}:${selectedOption.slug}`);
    await finalizeNationSelection(player, selectedOption);
  } catch (error) {
    clearActiveNationMenu(player);
    debugNationSelection(`show:catch:${player.name}:retry=${retryCount}`);
    if (retryCount > 0 || nationSelectionPending.has(player.id)) {
      system.runTimeout(() => {
        void openNationSelectionForm(player, {
          force: true,
          retryCount: Math.max(retryCount - 1, 0),
          retryDelayTicks,
          silentRetry: true
        });
      }, retryDelayTicks);
      return;
    }

    if (!silentRetry) {
      send(player, '\u00a7c[NACAO] Nao foi possivel abrir a tela agora. Feche o chat e tente novamente.');
    }
    sendNationSelectionHint(player);
  }
}

function sendLoginSummary(player, bundle) {
  const profile = bundle?.profile ?? {};
  const economy = bundle?.economy ?? {};
  const kingdomName = readProfileValue(profile.kingdomName, 'Sem reino');
  const nationName = readProfileValue(profile.nationName, 'Sem nacao');
  const className = readProfileValue(profile.className, 'Sem classe');

  send(player, `\u00a7a[NETWORK] Perfil carregado em \u00a7f${NETWORK_CONFIG.serverSlug}\u00a7a.`);
  send(player, `\u00a77Saldo: \u00a7e${formatDracoBalance(economy.balance ?? 0)} \u00a78| \u00a77Reino: \u00a76${kingdomName}`);
  send(player, `\u00a77Nacao: \u00a7b${nationName} \u00a78| \u00a77Classe: \u00a76${className}`);
}

async function handleAsyncPlayerJoin(event) {
  if (!event.isValid()) {
    return;
  }

  rememberPersistentIdentity(event.playerName, event.persistentId);
}

system.run(() => {
  adminBeforeEvents.asyncPlayerJoin.subscribe(handleAsyncPlayerJoin);
});

initializeServerRules();
initializeNationAbilities();

world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) {
    return;
  }

  const player = event.player;
  system.runTimeout(async () => {
    if (!isPlayerValid(player)) {
      return;
    }

    send(player, '\u00a7a[NETWORK] Sincronizando perfil compartilhado...');
    const result = await connectPlayer(player);
    if (!result.ok) {
      send(player, `\u00a7c[NETWORK] Falha ao carregar seu perfil compartilhado: ${result.error}`);
      return;
    }

    const profile = result.bundle?.profile ?? {};
    sendLoginSummary(player, result.bundle);

    if (!String(profile.nationSlug || '').trim()) {
      queueNationSelection(player);
      debugNationSelection(`spawn:no-nation:${player.name}`);
      send(player, '\u00a7e[NACAO] Voce ainda nao tem nacao. Abrindo a selecao...');
      system.runTimeout(() => {
        openNationSelectionForm(player, {
          retryCount: 6,
          retryDelayTicks: 30
        });
      }, 100);
      return;
    }

    clearNationSelection(player);

    if (!String(profile.className || '').trim()) {
      send(
        player,
        '\u00a7e[NAÇÃO] Você ainda não tem classe. Um lord da sua nação pode usar \u00a7f!promover Seu Nome Classe\u00a7e, mesmo se você estiver offline.'
      );
    }
  }, 20);
});

world.beforeEvents.playerLeave.subscribe((event) => {
  const player = event.player;
  clearNationSelection(player);
  system.run(async () => {
    await disconnectPlayer(player).catch(() => null);
  });
});

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    system.run(async () => {
      await savePlayerState(player).catch(() => null);
    });
  }
}, NETWORK_CONFIG.autosaveIntervalTicks);

system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    if (!nationSelectionPending.has(player.id)) {
      continue;
    }

    const cachedBundle = getCachedBundle(player);
    const currentNationSlug = String(cachedBundle?.profile?.nationSlug || '').trim();
    if (currentNationSlug) {
      clearNationSelection(player);
      continue;
    }

    queueNationSelection(player);
    openNationSelectionForm(player, {
      retryCount: 1,
      retryDelayTicks: 20,
      silentRetry: true
    });
  }
}, 120);

world.beforeEvents.chatSend.subscribe((event) => {
  const rawMessage = String(event.message || '').trim();
  const message = rawMessage.toLowerCase();
  const normalizedMessage = normalizeCommandText(rawMessage);
  const player = event.sender;

  // Skip commands if handled by transfer logic
  if (maybeHandleTransferCommand(event)) {
    return;
  }

  if (normalizedMessage === '!nacoes' || normalizedMessage === '!nacao') {
    event.cancel = true;
    system.runTimeout(() => {
      debugNationSelection(`command:nacoes:${player.name}`);
      queueNationSelection(player);
      send(player, '\u00a77[NACAO] Abrindo selecao...');
      openNationSelectionForm(player, {
        force: true,
        retryCount: 5,
        retryDelayTicks: 10
      });
    }, 8);
    return;
  }

  if (normalizedMessage.startsWith('!nacao ')) {
    event.cancel = true;
    const nationSlug = parseNationChoiceCommand(rawMessage);

    if (!nationSlug) {
      send(player, '\u00a7e[NAÇÃO] Uso: !nacao <fogo|agua|terra|vento>');
      return;
    }

    system.run(async () => {
      const result = await chooseNation(player, nationSlug);

      if (!result.ok) {
        switch (result.error) {
          case 'nation_already_selected':
            send(player, '\u00a7c[NAÇÃO] Você já escolheu uma nação para este personagem.');
            break;
          case 'nation_not_found':
            send(player, '\u00a7c[NAÇÃO] A nação informada não existe.');
            break;
          default:
            send(player, `\u00a7c[NAÇÃO] Falha ao escolher nação: ${result.error}`);
            break;
        }
        return;
      }

      const travelCommand = NATION_COMMAND_ALIAS[result.nationSlug] || '!mapas';
      const nationDisplayName = result.nationName || NATION_DISPLAY_NAME[result.nationSlug] || result.nationSlug;
      clearNationSelection(player);
      send(player, `\u00a7a[NAÇÃO] Você agora pertence a \u00a7b${nationDisplayName}\u00a7a.`);
      send(player, `\u00a77Para viajar ao seu mapa, use \u00a7f${travelCommand}\u00a77.`);
    });
    return;
  }

  if (normalizedMessage.startsWith('!promover')) {
    event.cancel = true;
    const parsedCommand = parsePromoteCommand(rawMessage);

    if (!parsedCommand) {
      send(player, '\u00a7e[NACAO] Uso: !promover <jogador> <classe>');
      send(
        player,
        '\u00a77Classes aceitas: guerreiro, construtor, ou o nome completo da classe da nação. Ex.: !promover Espoleta Azul guerreiro'
      );
      return;
    }

    system.run(async () => {
      const result = await promoteNationMember(player, parsedCommand.targetGamertag, parsedCommand.className);

      if (!result.ok) {
        switch (result.error) {
          case 'target_not_found':
            send(player, '\u00a7c[NAÇÃO] O jogador informado não existe no banco.');
            break;
          case 'target_without_nation':
            send(player, '\u00a7c[NAÇÃO] O jogador ainda não escolheu uma nação.');
            break;
          case 'insufficient_permissions':
            send(player, '\u00a7c[NAÇÃO] Apenas lordes da nação ou admins da rede podem promover.');
            break;
          case 'cross_nation_management_denied':
            send(player, '\u00a7c[NAÇÃO] Você só pode promover membros da sua própria nação.');
            break;
          case 'invalid_class_for_nation':
            send(player, '\u00a7c[NAÇÃO] Essa classe não pertence à nação atual do jogador.');
            break;
          case 'cannot_manage_self':
            send(player, '\u00a7c[NAÇÃO] Você não pode usar esse comando em si mesmo.');
            break;
          case 'cannot_manage_leader':
            send(player, '\u00a7c[NAÇÃO] Somente um admin da rede pode gerenciar outro lord.');
            break;
          default:
            send(player, `\u00a7c[NAÇÃO] Falha ao promover: ${result.error}`);
            break;
        }
        return;
      }

      send(
        player,
        `\u00a7a[NAÇÃO] \u00a7f${result.targetGamertag}\u00a7a foi promovido para \u00a76${result.className}\u00a7a.`
      );

      const refreshedTarget = await refreshOnlinePlayerBundle(result.targetGamertag);
      if (refreshedTarget?.player && refreshedTarget.player.id !== player.id) {
        send(
          refreshedTarget.player,
          `\u00a7a[NAÇÃO] Você foi promovido para \u00a76${result.className}\u00a7a em \u00a7b${result.nationName}\u00a7a.`
        );
      }
    });
    return;
  }

  if (normalizedMessage.startsWith('!rebaixar')) {
    event.cancel = true;
    const parsedCommand = parseSingleTargetCommand(rawMessage, 'rebaixar');

    if (!parsedCommand) {
      send(player, '\u00a7e[NAÇÃO] Uso: !rebaixar <jogador>');
      return;
    }

    system.run(async () => {
      const result = await demoteNationMember(player, parsedCommand.targetGamertag);

      if (!result.ok) {
        switch (result.error) {
          case 'target_not_found':
            send(player, '\u00a7c[NAÇÃO] O jogador informado não existe no banco.');
            break;
          case 'target_without_nation':
            send(player, '\u00a7c[NAÇÃO] O jogador ainda não pertence a nenhuma nação.');
            break;
          case 'insufficient_permissions':
            send(player, '\u00a7c[NAÇÃO] Apenas lordes da nação ou admins da rede podem rebaixar.');
            break;
          case 'cross_nation_management_denied':
            send(player, '\u00a7c[NAÇÃO] Você só pode rebaixar membros da sua própria nação.');
            break;
          case 'cannot_manage_self':
            send(player, '\u00a7c[NAÇÃO] Você não pode usar esse comando em si mesmo.');
            break;
          case 'cannot_manage_leader':
            send(player, '\u00a7c[NAÇÃO] Somente um admin da rede pode gerenciar outro lord.');
            break;
          default:
            send(player, `\u00a7c[NAÇÃO] Falha ao rebaixar: ${result.error}`);
            break;
        }
        return;
      }

      send(player, `\u00a7a[NAÇÃO] \u00a7f${result.targetGamertag}\u00a7a voltou para sem classe.`);

      const refreshedTarget = await refreshOnlinePlayerBundle(result.targetGamertag);
      if (refreshedTarget?.player && refreshedTarget.player.id !== player.id) {
        send(
          refreshedTarget.player,
          `\u00a7e[NAÇÃO] Sua classe foi removida em \u00a7b${result.nationName}\u00a7e.`
        );
      }
    });
    return;
  }

  if (normalizedMessage.startsWith('!expulsar')) {
    event.cancel = true;
    const parsedCommand = parseSingleTargetCommand(rawMessage, 'expulsar');

    if (!parsedCommand) {
      send(player, '\u00a7e[NAÇÃO] Uso: !expulsar <jogador>');
      return;
    }

    system.run(async () => {
      const result = await expelNationMember(player, parsedCommand.targetGamertag);

      if (!result.ok) {
        switch (result.error) {
          case 'target_not_found':
            send(player, '\u00a7c[NAÇÃO] O jogador informado não existe no banco.');
            break;
          case 'target_without_nation':
            send(player, '\u00a7c[NAÇÃO] O jogador ainda não pertence a nenhuma nação.');
            break;
          case 'insufficient_permissions':
            send(player, '\u00a7c[NAÇÃO] Apenas lordes da nação ou admins da rede podem expulsar.');
            break;
          case 'cross_nation_management_denied':
            send(player, '\u00a7c[NAÇÃO] Você só pode expulsar membros da sua própria nação.');
            break;
          case 'cannot_manage_self':
            send(player, '\u00a7c[NAÇÃO] Você não pode usar esse comando em si mesmo.');
            break;
          case 'cannot_manage_leader':
            send(player, '\u00a7c[NAÇÃO] Somente um admin da rede pode gerenciar outro lord.');
            break;
          default:
            send(player, `\u00a7c[NAÇÃO] Falha ao expulsar: ${result.error}`);
            break;
        }
        return;
      }

      send(
        player,
        `\u00a7a[NAÇÃO] \u00a7f${result.targetGamertag}\u00a7a foi expulso de \u00a7b${result.formerNationName}\u00a7a.`
      );

      const refreshedTarget = await refreshOnlinePlayerBundle(result.targetGamertag);
      if (refreshedTarget?.player && refreshedTarget.player.id !== player.id) {
        send(
          refreshedTarget.player,
          '\u00a7c[NAÇÃO] Você foi expulso da sua nação. Use \u00a7f!nacoes\u00a7c para escolher um novo caminho.'
        );
      }
    });
    return;
  }

  if (message === '!ricos' || message === '!top' || message === '!milionarios') {
    event.cancel = true;
    system.run(async () => {
      try {
        send(player, '\u00a76[ECONOMIA] Buscando os jogadores mais ricos...');
        const result = await getTopRicos();

        if (!result.ok) {
          send(player, `\u00a7c[ECONOMIA] Falha ao carregar ranking: ${result.error}`);
          return;
        }

        if (!result.top || result.top.length === 0) {
          send(player, '\u00a7e[ECONOMIA] Nenhum jogador milionário encontrado no ranking ainda.');
          return;
        }

        send(player, '\u00a76--- RANKING DE RICOS (DRACOS) ---');
        result.top.forEach((item, index) => {
          send(
            player,
            `\u00a7f${index + 1}. \u00a7b${item.gamertag}\u00a77: \u00a7e${formatDracoBalance(item.balance)}`
          );
        });
        send(player, '\u00a76---------------------------------');
      } catch (err) {
        send(player, `\u00a7c[ECONOMIA] Erro interno ao processar ranking.`);
        console.error(`RANKING_ERROR: ${err}`);
      }
    });
    return;
  }

  if (message === '!saldo' || message === '!money') {
    event.cancel = true;
    system.run(async () => {
      try {
        send(player, '\u00a77[ECONOMIA] Consultando saldo atualizado...');
        const refresh = await reloadPlayerBundle(player);
        
        if (!refresh.ok) {
           send(player, `\u00a7c[ECONOMIA] Falha ao sincronizar: ${refresh.error}`);
           return;
        }

        const balance = refresh.bundle?.economy?.balance ?? 0;
        send(
          player,
          `\u00a7a[ECONOMIA] Seu saldo atual é \u00a7e${formatDracoBalance(balance)}\u00a7a.`
        );
      } catch (err) {
        send(player, `\u00a7c[ECONOMIA] Erro ao consultar saldo.`);
      }
    });
    return;
  }

  if (message === '!saldonacao') {
    event.cancel = true;
    system.run(async () => {
      const refresh = await reloadPlayerBundle(player);
      const bundle = refresh.ok ? refresh.bundle : getCachedBundle(player);

      if (!bundle) {
        send(player, '\u00a7c[ECONOMIA] Não foi possível carregar o tesouro da nação.');
        return;
      }

      const nationName = readProfileValue(bundle.profile?.nationName, '');
      if (!nationName) {
        send(player, '\u00a7e[ECONOMIA] Você ainda não pertence a nenhuma nação.');
        return;
      }

      send(
        player,
        `\u00a7a[ECONOMIA] Tesouro de \u00a7b${nationName}\u00a7a: \u00a7e${formatDracoBalance(
          bundle.economy?.nationBalance ?? 0
        )}\u00a7a.`
      );
      if (!refresh.ok) {
        send(player, `\u00a7e[ECONOMIA] Exibindo cache local (${refresh.error}).`);
      }
    });
    return;
  }

  if (message === '!saldoreino') {
    event.cancel = true;
    system.run(async () => {
      const refresh = await reloadPlayerBundle(player);
      const bundle = refresh.ok ? refresh.bundle : getCachedBundle(player);

      if (!bundle) {
        send(player, '\u00a7c[ECONOMIA] Não foi possível carregar o tesouro do reino.');
        return;
      }

      const kingdomName = readProfileValue(bundle.profile?.kingdomName, '');
      if (!kingdomName) {
        send(player, '\u00a7e[ECONOMIA] Você ainda não pertence a nenhum reino.');
        return;
      }

      send(
        player,
        `\u00a7a[ECONOMIA] Tesouro de \u00a76${kingdomName}\u00a7a: \u00a7e${formatDracoBalance(
          bundle.economy?.kingdomBalance ?? 0
        )}\u00a7a.`
      );
      if (!refresh.ok) {
        send(player, `\u00a7e[ECONOMIA] Exibindo cache local (${refresh.error}).`);
      }
    });
    return;
  }

  if (message.startsWith('!pagar')) {
    event.cancel = true;
    const parsedCommand = parsePayCommand(rawMessage);

    if (!parsedCommand) {
      send(player, '\u00a7e[ECONOMIA] Uso: !pagar <jogador> <valor>');
      return;
    }

    if (!Number.isSafeInteger(parsedCommand.amount) || parsedCommand.amount <= 0) {
      send(player, '\u00a7c[ECONOMIA] Informe um valor inteiro positivo.');
      return;
    }

    system.run(async () => {
      const result = await transferBalance(player, parsedCommand.targetGamertag, parsedCommand.amount);

      if (!result.ok) {
        switch (result.error) {
          case 'recipient_not_found':
            send(player, '\u00a7c[ECONOMIA] O jogador informado não existe no banco.');
            break;
          case 'cannot_pay_self':
            send(player, '\u00a7c[ECONOMIA] Você não pode pagar a si mesmo.');
            break;
          case 'insufficient_funds':
            send(
              player,
              `\u00a7c[ECONOMIA] Saldo insuficiente. Saldo atual: \u00a7e${formatDracoBalance(
                result.details?.currentBalance ?? 0
              )}\u00a7c.`
            );
            break;
          case 'invalid_amount':
            send(player, '\u00a7c[ECONOMIA] Valor inválido para a transferência.');
            break;
          default:
            send(player, `\u00a7c[ECONOMIA] Falha ao transferir: ${result.error}`);
            break;
        }
        return;
      }

      send(
        player,
        `\u00a7a[ECONOMIA] Você enviou \u00a7e${formatDracoBalance(result.amount)}\u00a7a para \u00a7f${result.recipientGamertag}\u00a7a.`
      );
      send(player, `\u00a77Novo saldo: \u00a7e${formatDracoBalance(result.senderBalance)}`);

      const recipientPlayer = findOnlinePlayerByGamertag(result.recipientGamertag);
      if (recipientPlayer && recipientPlayer.id !== player.id) {
        setCachedBalance(recipientPlayer, result.recipientBalance);
        send(
          recipientPlayer,
          `\u00a7a[DRACO] Você recebeu \u00a7e${formatDracoBalance(result.amount)}\u00a7a de \u00a7f${player.name}\u00a7a.`
        );
        send(recipientPlayer, `\u00a77Novo saldo: \u00a7e${formatDracoBalance(result.recipientBalance)}`);
      }
    });
    return;
  }

  if (message.startsWith('!mint')) {
    event.cancel = true;
    const parsedCommand = parseMintCommand(rawMessage);

    if (!parsedCommand) {
      send(player, '\u00a7e[ADMIN] Uso: !mint <jogador> <valor>');
      return;
    }

    system.run(async () => {
      const result = await mintBalance(player, parsedCommand.targetGamertag, parsedCommand.amount);

      if (!result.ok) {
        send(player, `\u00a7c[ADMIN] Falha ao criar Dracos: ${result.error}`);
        return;
      }

      send(
        player,
        `\u00a7b[ADMIN] Você criou \u00a7e${formatDracoBalance(result.amount)}\u00a7b para \u00a7f${result.recipientGamertag}\u00a7b.`
      );

      const recipientPlayer = findOnlinePlayerByGamertag(result.recipientGamertag);
      if (recipientPlayer) {
        setCachedBalance(recipientPlayer, result.recipientBalance);
        send(
          recipientPlayer,
          `\u00a7a[DRACO] Você recebeu \u00a7e${formatDracoBalance(result.amount)}\u00a7a de \u00a7fAdministrador\u00a7a.`
        );
        send(recipientPlayer, `\u00a77Novo saldo: \u00a7e${formatDracoBalance(result.recipientBalance)}`);
      }
    });
    return;
  }

  if (message === '!netstatus') {
    event.cancel = true;
    system.run(async () => {
      const refresh = await reloadPlayerBundle(player);
      const bundle = refresh.ok ? refresh.bundle : getCachedBundle(player);

      if (!bundle) {
        send(player, '\u00a7c[NETWORK] Nenhum estado carregado para este jogador.');
        return;
      }

      send(player, `\u00a7a[NETWORK] Servidor: \u00a7f${NETWORK_CONFIG.serverSlug}`);
      send(player, `\u00a77Saldo: \u00a7e${formatDracoBalance(bundle.economy?.balance ?? 0)}`);
      send(player, `\u00a77Tesouro da nação: \u00a7b${formatDracoBalance(bundle.economy?.nationBalance ?? 0)}`);
      send(player, `\u00a77Tesouro do reino: \u00a76${formatDracoBalance(bundle.economy?.kingdomBalance ?? 0)}`);
      send(player, `\u00a77Revisão do inventário: \u00a7b${bundle.inventory?.revision ?? 0}`);
      send(player, `\u00a77Reino: \u00a76${readProfileValue(bundle.profile?.kingdomName, 'Sem reino')}`);
      send(player, `\u00a77Nação: \u00a7b${readProfileValue(bundle.profile?.nationName, 'Sem nação')}`);
      send(player, `\u00a77Raça: \u00a7d${readProfileValue(bundle.profile?.race, 'Sem raça')}`);
      send(player, `\u00a77Classe: \u00a76${readProfileValue(bundle.profile?.className, 'Sem classe')}`);
      send(player, `\u00a77Título: \u00a7a${readProfileValue(bundle.profile?.title, 'Sem título')}`);
      if (!refresh.ok) {
        send(player, `\u00a7e[NETWORK] Exibindo cache local (${refresh.error}).`);
      }
    });
    return;
  }

  if (message === '!netsave') {
    event.cancel = true;
    system.run(async () => {
      const result = await savePlayerState(player);
      if (!result.ok) {
        send(player, `\u00a7c[NETWORK] Falha ao salvar: ${result.error}`);
        return;
      }

      send(player, '\u00a7a[NETWORK] Estado compartilhado salvo com sucesso.');
    });
  }
});
