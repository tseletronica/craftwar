import { system } from '@minecraft/server';
import { transferPlayer } from '@minecraft/server-admin';

import { NETWORK_CONFIG } from './config.js';
import {
  clearPlayerAwaitingRedirect,
  clearPlayerTransferIntent,
  markPlayerAwaitingRedirect,
  markPlayerTransferIntent,
  savePlayerState
} from './player_sync.js';

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

function isTransferConfigured() {
  return Boolean(String(NETWORK_CONFIG.transferHost || '').trim());
}

function formatDestinations() {
  return DESTINATIONS.map((destination) => `${destination.name}: ${destination.aliases[0]}`).join(' §8| §7');
}

function findDestinationBySlug(slug) {
  const normalizedSlug = normalizeCommand(slug);
  return DESTINATIONS.find((destination) => normalizeCommand(destination.slug) === normalizedSlug) || null;
}

async function executeTransfer(player, destination, options = {}) {
  const {
    saveBeforeTransfer = true,
    markAsCommandTransfer = false,
    markAsLoginRedirect = false,
    showStatusMessages = true
  } = options;

  if (NETWORK_CONFIG.serverSlug === destination.slug) {
    if (showStatusMessages) {
      send(player, `§e[VIAGEM] Voce ja esta em §f${destination.name}§e.`);
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
      transferDestinationSlug: destination.slug
    });
    if (!saveResult.ok) {
      return { ok: false, error: `save_failed:${saveResult.error}` };
    }
  }

  if (markAsCommandTransfer) {
    markPlayerTransferIntent(player, destination.slug);
  }

  if (markAsLoginRedirect) {
    markPlayerAwaitingRedirect(player, destination.slug);
  }

  if (showStatusMessages) {
    send(
      player,
      `§a[VIAGEM] Transferindo para §f${destination.name}§a em §b${NETWORK_CONFIG.transferHost}:${destination.port}§a...`
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
    clearPlayerTransferIntent(player);
    clearPlayerAwaitingRedirect(player);

    if (saveBeforeTransfer) {
      await savePlayerState(player).catch(() => null);
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

export function maybeHandleTransferCommand(event) {
  const normalizedMessage = normalizeCommand(event.message);
  const player = event.sender;

  if (normalizedMessage === '!mapas' || normalizedMessage === '!servidores') {
    event.cancel = true;
    system.run(() => {
      send(player, `§a[VIAGEM] §7Destinos: ${formatDestinations()}`);
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

function queueTransfer(player, destination) {
  void (async () => {
    const result = await executeTransfer(player, destination, {
      saveBeforeTransfer: true,
      markAsCommandTransfer: true,
      showStatusMessages: true
    });

    if (result.ok) {
      return;
    }

    if (result.error === 'transfer_host_not_configured') {
      send(player, '§c[VIAGEM] O TRANSFER_HOST nao esta configurado neste servidor.');
      return;
    }

    if (String(result.error || '').startsWith('invalid_destination_port:')) {
      send(player, `§c[VIAGEM] Porta invalida para o destino ${destination.slug}.`);
      return;
    }

    if (String(result.error || '').startsWith('save_failed:')) {
      send(player, `§c[VIAGEM] Falha ao salvar antes da viagem: ${String(result.error).slice('save_failed:'.length)}`);
      return;
    }

    send(player, `§c[VIAGEM] Nao foi possivel transferir: ${result.error}`);
  })();
}
