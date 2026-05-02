import { PoolClient } from "pg";
import { z } from "zod";

import { pool } from "../lib/db.js";
import { rejectGamertagFallbackXuid } from "../lib/player-identity.js";

export const joinPayloadSchema = z
  .object({
    xuid: z.string().min(1),
    gamertag: z.string().min(1),
    serverSlug: z.string().min(1),
    legacyXuids: z.array(z.string().min(1)).default([])
  })
  .superRefine(rejectGamertagFallbackXuid);

export const inventoryPayloadSchema = z
  .object({
    xuid: z.string().min(1),
    gamertag: z.string().min(1),
    serverSlug: z.string().min(1),
    legacyXuids: z.array(z.string().min(1)).default([]),
    transferDestinationSlug: z.string().min(1).optional().nullable(),
    inventory: z.array(z.unknown()).default([]),
    armor: z.array(z.unknown()).default([]),
    enderChest: z.array(z.unknown()).default([]),
    offhand: z.unknown().default({}),
    hotbarSlot: z.number().int().min(0).max(8).default(0),
    experienceLevel: z.number().int().min(0).default(0),
    totalExperience: z.number().int().min(0).default(0),
    health: z.number().min(0).default(20),
    hunger: z.number().int().min(0).max(20).default(20),
    saturation: z.number().min(0).default(5),
    metadata: z.record(z.unknown()).default({})
  })
  .superRefine(rejectGamertagFallbackXuid);

export const leavePayloadSchema = z.object({
  xuid: z.string().min(1),
  serverSlug: z.string().min(1),
  reason: z.string().max(120).optional()
});

export const statePayloadSchema = z.object({
  xuid: z.string().min(1)
});

type JoinPayload = z.infer<typeof joinPayloadSchema>;
type InventoryPayload = z.infer<typeof inventoryPayloadSchema>;
type LeavePayload = z.infer<typeof leavePayloadSchema>;
type StatePayload = z.infer<typeof statePayloadSchema>;

type PresenceRow = {
  currentServerId: string | null;
  currentServerSlug: string | null;
  lastServerId: string | null;
  lastServerSlug: string | null;
  lastServerName: string | null;
  pendingTransferServerId: string | null;
  pendingTransferServerSlug: string | null;
  pendingTransferServerName: string | null;
};

type JoinRedirect = {
  serverSlug: string;
  serverName: string;
  reason: "pending_transfer" | "last_server_resume";
};

type JoinResult = {
  state: Record<string, unknown> | null;
  redirect: JoinRedirect | null;
};

async function findServerId(client: PoolClient, serverSlug: string) {
  const serverResult = await client.query<{ id: string }>(
    `
      select id
      from game_servers
      where slug = $1
        and is_active = true
      limit 1
    `,
    [serverSlug]
  );

  if (!serverResult.rowCount) {
    throw new Error(`Unknown server slug: ${serverSlug}`);
  }

  return serverResult.rows[0].id;
}

async function findPlayerIdByXuid(client: PoolClient, xuid: string) {
  const playerResult = await client.query<{ id: string }>(
    `
      select id
      from players
      where xuid = $1
      limit 1
    `,
    [xuid]
  );

  return playerResult.rows[0]?.id ?? null;
}

async function ensurePlayer(client: PoolClient, payload: JoinPayload | InventoryPayload) {
  const exactPlayerResult = await client.query<{ id: string }>(
    `
      update players
      set gamertag = $2,
          last_seen_at = now()
      where xuid = $1
      returning id
    `,
    [payload.xuid, payload.gamertag]
  );

  if (exactPlayerResult.rowCount) {
    return exactPlayerResult.rows[0].id;
  }

  const legacyXuids = Array.from(
    new Set(
      payload.legacyXuids
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value !== payload.xuid)
    )
  );

  if (legacyXuids.length) {
    const legacyPlayerResult = await client.query<{ id: string }>(
      `
        select id
        from players
        where xuid = any($1::text[])
        order by created_at asc
        limit 1
      `,
      [legacyXuids]
    );

    const legacyPlayerId = legacyPlayerResult.rows[0]?.id ?? null;
    if (legacyPlayerId) {
      await client.query(
        `
          update players
          set xuid = $2,
              gamertag = $3,
              last_seen_at = now()
          where id = $1
        `,
        [legacyPlayerId, payload.xuid, payload.gamertag]
      );

      return legacyPlayerId;
    }
  }

  const playerResult = await client.query<{ id: string }>(
    `
      insert into players (xuid, gamertag, last_seen_at)
      values ($1, $2, now())
      on conflict (xuid) do update
        set gamertag = excluded.gamertag,
            last_seen_at = now()
      returning id
    `,
    [payload.xuid, payload.gamertag]
  );

  return playerResult.rows[0].id;
}

async function ensurePlayerAccount(client: PoolClient, playerId: string) {
  await client.query(
    `
      insert into accounts (currency_code, player_id, balance)
      values ('DRACO', $1, 0)
      on conflict (currency_code, player_id) do nothing
    `,
    [playerId]
  );
}

async function loadPlayerPresence(client: PoolClient, playerId: string) {
  const presenceResult = await client.query<PresenceRow>(
    `
      select
        psp.current_server_id as "currentServerId",
        current_server.slug as "currentServerSlug",
        psp.last_server_id as "lastServerId",
        last_server.slug as "lastServerSlug",
        last_server.name as "lastServerName",
        psp.pending_transfer_server_id as "pendingTransferServerId",
        pending_server.slug as "pendingTransferServerSlug",
        pending_server.name as "pendingTransferServerName"
      from player_server_presence psp
      left join game_servers current_server
        on current_server.id = psp.current_server_id
       and current_server.is_active = true
      left join game_servers last_server
        on last_server.id = psp.last_server_id
       and last_server.is_active = true
      left join game_servers pending_server
        on pending_server.id = psp.pending_transfer_server_id
       and pending_server.is_active = true
      where psp.player_id = $1
      limit 1
    `,
    [playerId]
  );

  return presenceResult.rows[0] ?? null;
}

function resolveJoinRedirect(presence: PresenceRow | null, serverId: string) {
  if (
    presence?.pendingTransferServerId &&
    presence.pendingTransferServerId !== serverId &&
    presence.pendingTransferServerSlug
  ) {
    return {
      serverSlug: presence.pendingTransferServerSlug,
      serverName: presence.pendingTransferServerName || presence.pendingTransferServerSlug,
      reason: "pending_transfer" as const
    };
  }

  if (presence?.lastServerId && presence.lastServerId !== serverId && presence.lastServerSlug) {
    return {
      serverSlug: presence.lastServerSlug,
      serverName: presence.lastServerName || presence.lastServerSlug,
      reason: "last_server_resume" as const
    };
  }

  return null;
}

export async function loadPlayerState(client: PoolClient, playerId: string) {
  const startTime = Date.now();

  const [profileResult, inventoryResult] = await Promise.all([
    client.query(
      `
        select
          p.id as "playerId",
          p.xuid,
          p.gamertag,
          p.race,
          p.class_name as "className",
          p.title,
          n.slug as "nationSlug",
          n.name as "nationName",
          k.slug as "kingdomSlug",
          k.name as "kingdomName",
          c.id as "clanId",
          c.name as "clanName",
          c.tag as "clanTag",
          coalesce(a.balance, 0) as "dracoBalance",
          coalesce(na.balance, 0) as "nationDracoBalance",
          coalesce(ka.balance, 0) as "kingdomDracoBalance"
        from players p
        left join nation_memberships nm on nm.player_id = p.id and nm.left_at is null
        left join nations n on n.id = nm.nation_id
        left join kingdoms k on k.id = n.kingdom_id
        left join clan_memberships cm on cm.player_id = p.id and cm.left_at is null
        left join clans c on c.id = cm.clan_id
        left join accounts a on a.player_id = p.id and a.currency_code = 'DRACO'
        left join accounts na on na.nation_id = n.id and na.currency_code = 'DRACO'
        left join accounts ka on ka.kingdom_id = k.id and ka.currency_code = 'DRACO'
        where p.id = $1
        limit 1
      `,
      [playerId]
    ),
    client.query(
      `
        select
          coalesce(inventory_json, '[]'::jsonb) as inventory,
          coalesce(armor_json, '[]'::jsonb) as armor,
          coalesce(ender_chest_json, '[]'::jsonb) as "enderChest",
          coalesce(offhand_json, '{}'::jsonb) as offhand,
          coalesce(hotbar_slot, 0) as "hotbarSlot",
          coalesce(experience_level, 0) as "experienceLevel",
          coalesce(total_experience, 0) as "totalExperience",
          coalesce(health, 20) as health,
          coalesce(hunger, 20) as hunger,
          coalesce(saturation, 5) as saturation,
          coalesce(inventory_version, 0) as "inventoryVersion"
        from player_inventories
        where player_id = $1
        limit 1
      `,
      [playerId]
    )
  ]);

  const duration = Date.now() - startTime;
  if (duration > 500) {
    console.warn(`[PERF] loadPlayerState took ${duration}ms for player ${playerId}`);
  }

  const profile = profileResult.rows[0] ?? null;
  if (!profile) {
    return null;
  }

  const inventory = inventoryResult.rows[0] ?? {
    inventory: [],
    armor: [],
    enderChest: [],
    offhand: {},
    hotbarSlot: 0,
    experienceLevel: 0,
    totalExperience: 0,
    health: 20,
    hunger: 20,
    saturation: 5,
    inventoryVersion: 0
  };

  return {
    ...profile,
    ...inventory
  };
}

export async function handleJoin(payload: JoinPayload): Promise<JoinResult> {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const serverId = await findServerId(client, payload.serverSlug);
    const playerId = await ensurePlayer(client, payload);
    const presence = await loadPlayerPresence(client, playerId);
    const redirect = resolveJoinRedirect(presence, serverId);

    await ensurePlayerAccount(client, playerId);

    if (redirect) {
      await client.query("commit");
      return {
        state: null,
        redirect
      };
    }

    await client.query(
      `
        insert into player_server_presence (
          player_id,
          current_server_id,
          last_server_id,
          pending_transfer_server_id,
          online,
          last_joined_at,
          updated_at
        )
        values ($1, $2, $2, null, true, now(), now())
        on conflict (player_id) do update
          set current_server_id = excluded.current_server_id,
              last_server_id = excluded.last_server_id,
              pending_transfer_server_id = null,
              online = true,
              last_joined_at = now(),
              updated_at = now()
      `,
      [playerId, serverId]
    );

    await client.query(
      `
        insert into player_sessions (player_id, server_id)
        values ($1, $2)
      `,
      [playerId, serverId]
    );

    const state = await loadPlayerState(client, playerId);

    await client.query("commit");
    return {
      state,
      redirect: null
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPlayerState(payload: StatePayload) {
  const client = await pool.connect();

  try {
    const playerId = await findPlayerIdByXuid(client, payload.xuid);
    if (!playerId) {
      return null;
    }

    return await loadPlayerState(client, playerId);
  } finally {
    client.release();
  }
}

export async function saveInventory(payload: InventoryPayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const serverId = await findServerId(client, payload.serverSlug);
    const transferDestinationSlug =
      typeof payload.transferDestinationSlug === "string" ? payload.transferDestinationSlug.trim() : "";
    const transferDestinationServerId = transferDestinationSlug
      ? await findServerId(client, transferDestinationSlug)
      : null;
    const playerId = await ensurePlayer(client, payload);
    await ensurePlayerAccount(client, playerId);

    const inventoryResult = await client.query<{ inventoryVersion: string }>(
      `
        insert into player_inventories (
          player_id,
          inventory_json,
          armor_json,
          ender_chest_json,
          offhand_json,
          hotbar_slot,
          experience_level,
          total_experience,
          health,
          hunger,
          saturation,
          metadata,
          inventory_version,
          updated_by_server_id,
          updated_at
        )
        values (
          $1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb,
          $6, $7, $8, $9, $10, $11, $12::jsonb, 1, $13, now()
        )
        on conflict (player_id) do update
          set inventory_json = excluded.inventory_json,
              armor_json = excluded.armor_json,
              ender_chest_json = excluded.ender_chest_json,
              offhand_json = excluded.offhand_json,
              hotbar_slot = excluded.hotbar_slot,
              experience_level = excluded.experience_level,
              total_experience = excluded.total_experience,
              health = excluded.health,
              hunger = excluded.hunger,
              saturation = excluded.saturation,
              metadata = excluded.metadata,
              updated_by_server_id = excluded.updated_by_server_id,
              updated_at = now(),
              inventory_version = player_inventories.inventory_version + 1
        returning inventory_version as "inventoryVersion"
      `,
      [
        playerId,
        JSON.stringify(payload.inventory),
        JSON.stringify(payload.armor),
        JSON.stringify(payload.enderChest),
        JSON.stringify(payload.offhand),
        payload.hotbarSlot,
        payload.experienceLevel,
        payload.totalExperience,
        payload.health,
        payload.hunger,
        payload.saturation,
        JSON.stringify(payload.metadata),
        serverId
      ]
    );

    const inventoryVersion = Number(inventoryResult.rows[0].inventoryVersion);

    await client.query(
      `
        insert into player_server_presence (
          player_id,
          current_server_id,
          last_server_id,
          pending_transfer_server_id,
          online,
          last_inventory_version,
          updated_at
        )
        values ($1, $2, $2, $4, true, $3, now())
        on conflict (player_id) do update
          set current_server_id = excluded.current_server_id,
              last_server_id = excluded.last_server_id,
              pending_transfer_server_id = excluded.pending_transfer_server_id,
              online = true,
              last_inventory_version = excluded.last_inventory_version,
              updated_at = now()
      `,
      [playerId, serverId, inventoryVersion, transferDestinationServerId]
    );

    await client.query(
      `
        insert into inventory_sync_events (
          player_id,
          server_id,
          event_type,
          snapshot_version,
          payload
        )
        values ($1, $2, 'save', $3, $4::jsonb)
      `,
      [
        playerId,
        serverId,
        inventoryVersion,
        JSON.stringify({
          inventorySize: payload.inventory.length,
          armorSize: payload.armor.length,
          metadata: payload.metadata
        })
      ]
    );

    if (transferDestinationServerId && transferDestinationSlug) {
      await client.query(
        `
          insert into inventory_sync_events (
            player_id,
            server_id,
            event_type,
            snapshot_version,
            payload
          )
          values ($1, $2, 'transfer', $3, $4::jsonb)
        `,
        [
          playerId,
          serverId,
          inventoryVersion,
          JSON.stringify({
            fromServerSlug: payload.serverSlug,
            destinationServerSlug: transferDestinationSlug
          })
        ]
      );
    }

    await client.query("commit");
    return {
      playerId,
      inventoryVersion
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function handleLeave(payload: LeavePayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const serverId = await findServerId(client, payload.serverSlug);
    const playerId = await findPlayerIdByXuid(client, payload.xuid);

    if (!playerId) {
      throw new Error(`Player not found for xuid: ${payload.xuid}`);
    }

    await client.query(
      `
        update player_server_presence
        set current_server_id = case
              when current_server_id = $2 then null
              else current_server_id
            end,
            online = case
              when current_server_id = $2 then false
              else online
            end,
            last_left_at = now(),
            updated_at = now()
        where player_id = $1
      `,
      [playerId, serverId]
    );

    await client.query(
      `
        with latest as (
          select id
          from player_sessions
          where player_id = $1
            and server_id = $2
            and disconnected_at is null
          order by connected_at desc
          limit 1
        )
        update player_sessions
        set disconnected_at = now(),
            disconnect_reason = $3
        where id in (select id from latest)
      `,
      [playerId, serverId, payload.reason ?? null]
    );

    await client.query("commit");
    return {
      playerId,
      serverSlug: payload.serverSlug,
      status: "offline"
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
