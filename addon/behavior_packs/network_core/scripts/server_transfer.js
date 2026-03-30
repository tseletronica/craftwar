import { system } from '@minecraft/server';
import { transferPlayer } from '@minecraft/server-admin';

import { NETWORK_CONFIG } from './config.js';
import { savePlayerState } from './player_sync.js';

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
    name: 'Nação do Fogo',
    port: NETWORK_CONFIG.firePort,
    aliases: ['!fogo', '!fire']
  },
  {
    slug: 'water',
    name: 'Nação da Água',
    port: NETWORK_CONFIG.waterPort,
    aliases: ['!agua', '!water']
  },
  {
    slug: 'earth',
    name: 'Nação da Terra',
    port: NETWORK_CONFIG.earthPort,
    aliases: ['!terra', '!earth']
  },
  {
    slug: 'air',
    name: 'Nação do Vento',
    port: NETWORK_CONFIG.airPort,
    aliases: ['!vento', '!air']
  },
  {
    slug: 'exploration',
    name: 'Mapa de Exploração',
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
    if (NETWORK_CONFIG.serverSlug === destination.slug) {
      send(player, `§e[VIAGEM] Você já está em §f${destination.name}§e.`);
      return;
    }

    if (!isTransferConfigured()) {
      send(player, '§c[VIAGEM] O TRANSFER_HOST não está configurado neste servidor.');
      return;
    }

    if (!Number.isFinite(destination.port) || destination.port <= 0) {
      send(player, `§c[VIAGEM] Porta inválida para o destino ${destination.slug}.`);
      return;
    }

    const saveResult = await savePlayerState(player);
    if (!saveResult.ok) {
      send(player, `§c[VIAGEM] Falha ao salvar antes da viagem: ${saveResult.error}`);
      return;
    }

    send(
      player,
      `§a[VIAGEM] Transferindo para §f${destination.name}§a em §b${NETWORK_CONFIG.transferHost}:${destination.port}§a...`
    );

    try {
      transferPlayer(player, {
        hostname: NETWORK_CONFIG.transferHost,
        port: destination.port
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'transfer_failed';
      send(player, `§c[VIAGEM] Não foi possível transferir: ${reason}`);
    }
  })();
}
