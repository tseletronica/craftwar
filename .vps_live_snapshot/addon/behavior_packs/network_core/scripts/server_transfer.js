import { system } from '@minecraft/server';
import { transferPlayer } from '@minecraft/server-admin';

import { NETWORK_CONFIG } from './config.js';
import {
  clearPlayerAwaitingRedirect,
  clearPlayerTransferIntent,
  clearTransferLeave,
  markPlayerAwaitingRedirect,
  markPlayerTransferIntent,
  markTransferLeave,
  savePlayerState
} from './player_sync.js';

const TRANSFER_DELAY_TICKS = 200;
const TRANSFER_DELAY_SECONDS = Math.floor(TRANSFER_DELAY_TICKS / 20);
const TRANSFER_COUNTDOWN_STEP_TICKS = 20;
const pendingTransfers = new Map();

const DESTINATIONS = [
  {
    slug: 'capital',
    name: 'Capital',
    port: NETWORK_CONFIG.capitalPort,
    aliases: ['!capital', '!hub']
  },
  {
    slug: 'arenas',
    name: 'Arenas',
    port: NETWORK_CONFIG.arenasPort,
    aliases: ['!arenas', '!arena']
  },
  {
    slug: 'fire',
    name: 'Nacao do Fogo',
    port: NETWORK_CONFIG.firePort,
    aliases: ['!fogo', '!fire']
  },
  {
    slug: 'water',
    name: 'Nacao da Agua',
    port: NETWORK_CONFIG.waterPort,
    aliases: ['!agua', '!water']
  },
  {
    slug: 'earth',
    name: 'Nacao da Terra',
    port: NETWORK_CONFIG.earthPort,
    aliases: ['!terra', '!earth']
  },
  {
    slug: 'air',
    name: 'Nacao do Vento',
    port: NETWORK_CONFIG.airPort,
    aliases: ['!vento', '!air']
  },
  {
    slug: 'exploration',
    name: 'Mapa de Exploracao',
    port: NETWORK_CONFIG.explorationPort,
    aliases: ['!exploracao', '!exploration', '!explorar']
  }
];

const DESTINATION_BY_COMMAND = new Map();
for (const destination of DESTINATIONS) {
  for (const alias of destination.aliases) {
    DESTINATION_BY_COMMAND.set(normalizeCommand(alias), destination);
  }
}

function normalizeCommand(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function send(player, message) {
  try {
    player.sendMessage(message);
  } catch (error) {
  }
}

function setActionBar(player, message) {
  try {
    player.onScreenDisplay?.setActionBar?.(message);
  } catch (error) {
  }
}

function isValidPlayer(player) {
  try {
    if (!player) {
      return false;
    }

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

function isTransferConfigured() {
  return Boolean(String(NETWORK_CONFIG.transferHost || '').trim());
}

function formatDestinations() {
  return DESTINATIONS.map((destination) => `${destination.name}: ${destination.aliases[0]}`).join(' \u00a78| \u00a77');
}

function findDestinationBySlug(slug) {
  const normalizedSlug = normalizeCommand(slug);
  return DESTINATIONS.find((destination) => normalizeCommand(destination.slug) === normalizedSlug) || null;
}

function clearPendingTransfer(playerId) {
  const pending = pendingTransfers.get(playerId);
  if (!pending) {
    return;
  }

  try {
    system.clearRun(pending.runId);
  } catch (error) {
  }

  try {
    system.clearRun(pending.countdownRunId);
  } catch (error) {
  }

  pendingTransfers.delete(playerId);
}

function scheduleTransferCountdown(player, destination, secondsRemaining) {
  if (!isValidPlayer(player) || secondsRemaining <= 0) {
    return;
  }

  const pending = pendingTransfers.get(player.id);
  if (!pending || pending.destination?.slug !== destination.slug) {
    return;
  }

  setActionBar(player, `\u00a7e[VIAGEM] \u00a7f${destination.name}\u00a77 em \u00a7b${secondsRemaining}\u00a77s`);

  pending.countdownRunId = system.runTimeout(() => {
    scheduleTransferCountdown(player, destination, secondsRemaining - 1);
  }, TRANSFER_COUNTDOWN_STEP_TICKS);
}

export function maybeHandleTransferCommand(event) {
  const normalizedMessage = normalizeCommand(event.message);
  const player = event.sender;

  if (normalizedMessage === '!mapas' || normalizedMessage === '!servidores') {
    event.cancel = true;
    system.run(() => {
      send(player, `\u00a7a[VIAGEM] \u00a77Destinos: ${formatDestinations()}`);
    });
    return true;
  }

  const destination = DESTINATION_BY_COMMAND.get(normalizedMessage);
  if (!destination) {
    return false;
  }

  event.cancel = true;
  system.run(() => {
    queueTransfer(player, destination);
  });
  return true;
}

async function executeTransfer(player, destination, options = {}) {
  const {
    saveBeforeTransfer = true,
    markAsCommandTransfer = false,
    markAsLoginRedirect = false,
    showStatusMessages = true
  } = options;

  if (!isValidPlayer(player)) {
    return { ok: false, error: 'player_invalid' };
  }

  if (NETWORK_CONFIG.serverSlug === destination.slug) {
    if (showStatusMessages) {
      send(player, `\u00a7e[VIAGEM] Voce ja esta em \u00a7f${destination.name}\u00a7e.`);
    }
    return { ok: true, skipped: true };
  }

  if (!isTransferConfigured()) {
    return { ok: false, error: 'transfer_host_not_configured' };
  }

  if (!Number.isFinite(destination.port) || destination.port <= 0) {
    return { ok: false, error: `invalid_destination_port:${destination.slug}` };
  }

  if (saveBeforeTransfer) {
    const saveResult = await savePlayerState(player, {
      reason: 'transfer',
      transferDestinationSlug: destination.slug
    });
    if (!saveResult.ok) {
      return { ok: false, error: `save_failed:${saveResult.error}` };
    }
  }

  if (markAsCommandTransfer) {
    markPlayerTransferIntent(player, destination.slug);
    markTransferLeave(player, destination.slug);
  }

  if (markAsLoginRedirect) {
    markPlayerAwaitingRedirect(player, destination.slug);
  }

  if (showStatusMessages) {
    send(
      player,
      `\u00a7a[VIAGEM] Transferindo para \u00a7f${destination.name}\u00a7a em \u00a7b${NETWORK_CONFIG.transferHost}:${destination.port}\u00a7a...`
    );
  }

  try {
    transferPlayer(player, {
      hostname: NETWORK_CONFIG.transferHost,
      port: destination.port
    });

    return {
      ok: true,
      destinationSlug: destination.slug,
      destinationName: destination.name
    };
  } catch (error) {
    clearTransferLeave(player);
    clearPlayerTransferIntent(player);
    clearPlayerAwaitingRedirect(player);

    if (saveBeforeTransfer) {
      await savePlayerState(player, { reason: 'transfer_recovery' }).catch(() => null);
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : 'transfer_failed'
    };
  }
}

export async function transferPlayerToSlug(player, destinationSlug, options = {}) {
  const destination = findDestinationBySlug(destinationSlug);
  if (!destination) {
    return { ok: false, error: `unknown_destination:${destinationSlug}` };
  }

  return executeTransfer(player, destination, options);
}

function queueTransfer(player, destination) {
  if (!isValidPlayer(player)) {
    return;
  }

  if (NETWORK_CONFIG.serverSlug === destination.slug) {
    send(player, `\u00a7e[VIAGEM] Voce ja esta em \u00a7f${destination.name}\u00a7e.`);
    return;
  }

  if (!isTransferConfigured()) {
    send(player, '\u00a7c[VIAGEM] O TRANSFER_HOST nao esta configurado neste servidor.');
    return;
  }

  if (!Number.isFinite(destination.port) || destination.port <= 0) {
    send(player, `\u00a7c[VIAGEM] Porta invalida para o destino ${destination.slug}.`);
    return;
  }

  clearPendingTransfer(player.id);
  send(
    player,
    `\u00a7e[VIAGEM] Viagem para \u00a7f${destination.name}\u00a7e iniciada. Teleporte em \u00a7b${TRANSFER_DELAY_SECONDS} segundos\u00a7e...`
  );

  pendingTransfers.set(player.id, {
    destination,
    runId: null,
    countdownRunId: null
  });

  scheduleTransferCountdown(player, destination, TRANSFER_DELAY_SECONDS);

  const runId = system.runTimeout(() => {
    pendingTransfers.delete(player.id);
    setActionBar(player, '\u00a7a[VIAGEM] Transferindo...');
    void performTransfer(player, destination);
  }, TRANSFER_DELAY_TICKS);

  pendingTransfers.set(player.id, {
    ...(pendingTransfers.get(player.id) || {}),
    destination,
    runId
  });
}

async function performTransfer(player, destination) {
  const result = await executeTransfer(player, destination, {
    saveBeforeTransfer: true,
    markAsCommandTransfer: true,
    showStatusMessages: true
  });

  if (!result.ok) {
    if (result.error === 'transfer_host_not_configured') {
      send(player, '\u00a7c[VIAGEM] O TRANSFER_HOST nao esta configurado neste servidor.');
      return;
    }

    if (String(result.error || '').startsWith('invalid_destination_port:')) {
      send(player, `\u00a7c[VIAGEM] Porta invalida para o destino ${destination.slug}.`);
      return;
    }

    if (String(result.error || '').startsWith('save_failed:')) {
      send(player, `\u00a7c[VIAGEM] Falha ao salvar antes da viagem: ${String(result.error).slice('save_failed:'.length)}`);
      return;
    }

    send(player, `\u00a7c[VIAGEM] Nao foi possivel transferir: ${result.error}`);
  }
}
