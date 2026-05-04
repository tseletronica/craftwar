import { PoolClient } from "pg";
import { z } from "zod";

import { pool } from "../lib/db.js";
import { rejectGamertagFallbackXuid } from "../lib/player-identity.js";
import { isAdmin } from "./admin.js";

export const joinPayloadSchema = z.object({
  xuid: z.string().min(1),
  gamertag: z.string().min(1),
  serverSlug: z.string().min(1),
  legacyXuids: z.array(z.string().min(1)).default([])
}).superRefine(rejectGamertagFallbackXuid);

export const inventoryPayloadSchema = z.object({
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
}).superRefine(rejectGamertagFallbackXuid);

export const leavePayloadSchema = z.object({
  xuid: z.string().min(1),
  serverSlug: z.string().min(1),
  reason: z.string().max(120).optional()
});

export const statePayloadSchema = z.object({
  xuid: z.string().min(1)
});

export const racePowerPayloadSchema = z.object({
  xuid: z.string().min(1),
  gamertag: z.string().min(1),
  serverSlug: z.string().min(1),
  legacyXuids: z.array(z.string().min(1)).default([]),
  raceKey: z.string().min(1),
  cooldownMs: z.number().int().min(1).max(3600000)
}).superRefine(rejectGamertagFallbackXuid);

type JoinPayload = z.infer<typeof joinPayloadSchema>;
type InventoryPayload = z.infer<typeof inventoryPayloadSchema>;
type LeavePayload = z.infer<typeof leavePayloadSchema>;
type StatePayload = z.infer<typeof statePayloadSchema>;
type RacePowerPayload = z.infer<typeof racePowerPayloadSchema>;

const LOGIN_REWARD_TIMEZONE = "America/Sao_Paulo";
const DAILY_LOGIN_REWARD_SCHEDULE = [10, 20, 30, 40, 50, 60, 100] as const;

type PlayerAccountRow = {
  id: string;
  balance: string;
};

type DailyLoginRewardRow = {
  streakDays: number;
  lastClaimDate: string | null;
  lastRewardAmount: number;
  totalClaims: number;
};

type DailyLoginWindowRow = {
  today: string;
  yesterday: string;
  sevenDayWindowStart: string;
};

type DailyLoginActivityRow = {
  activePlayersToday: number;
  activePlayers7d: number;
};

type DailyLoginRewardStatus = {
  rewardGranted: boolean;
  rewardAmount: number;
  claimedToday: boolean;
  streakDays: number;
  rewardCycleDay: number;
  nextRewardAmount: number;
  activePlayersToday: number;
  activePlayers7d: number;
  weeklyCycleLength: number;
};

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

async function ensurePlayer(client: PoolClient, payload: JoinPayload | InventoryPayload | RacePowerPayload) {
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

function getDailyRewardCycleDay(streakDays: number) {
  if (streakDays <= 0) {
    return 0;
  }

  return ((streakDays - 1) % DAILY_LOGIN_REWARD_SCHEDULE.length) + 1;
}

function getDailyRewardAmount(streakDays: number) {
  const cycleDay = getDailyRewardCycleDay(streakDays);
  if (cycleDay <= 0) {
    return 0;
  }

  return DAILY_LOGIN_REWARD_SCHEDULE[cycleDay - 1] ?? 0;
}

async function lockPlayerDracoAccount(client: PoolClient, playerId: string) {
  const accountResult = await client.query<PlayerAccountRow>(
    `
      select id, balance
      from accounts
      where currency_code = 'DRACO'
        and player_id = $1
      limit 1
      for update
    `,
    [playerId]
  );

  return accountResult.rows[0] ?? null;
}

async function getDailyLoginWindow(client: PoolClient) {
  const windowResult = await client.query<DailyLoginWindowRow>(
    `
      select
        timezone($1, now())::date::text as today,
        (timezone($1, now())::date - 1)::text as yesterday,
        (timezone($1, now())::date - 6)::text as "sevenDayWindowStart"
    `,
    [LOGIN_REWARD_TIMEZONE]
  );

  return windowResult.rows[0];
}

async function getDailyLoginActivity(client: PoolClient, today: string, sevenDayWindowStart: string) {
  const activityResult = await client.query<DailyLoginActivityRow>(
    `
      select
        count(*) filter (where last_claim_date = $1)::int as "activePlayersToday",
        count(*) filter (where last_claim_date >= $2)::int as "activePlayers7d"
      from player_daily_login_rewards
    `,
    [today, sevenDayWindowStart]
  );

  return activityResult.rows[0] ?? {
    activePlayersToday: 0,
    activePlayers7d: 0
  };
}

async function applyDailyLoginReward(client: PoolClient, playerId: string, serverId: string) {
  const { today, yesterday, sevenDayWindowStart } = await getDailyLoginWindow(client);

  const rewardStateResult = await client.query<DailyLoginRewardRow>(
    `
      select
        streak_days as "streakDays",
        last_claim_date::text as "lastClaimDate",
        last_reward_amount as "lastRewardAmount",
        total_claims as "totalClaims"
      from player_daily_login_rewards
      where player_id = $1
      limit 1
      for update
    `,
    [playerId]
  );

  const currentRewardState = rewardStateResult.rows[0] ?? {
    streakDays: 0,
    lastClaimDate: null,
    lastRewardAmount: 0,
    totalClaims: 0
  };

  const alreadyClaimedToday = currentRewardState.lastClaimDate === today;
  let nextStreakDays = currentRewardState.streakDays;
  let rewardAmount = 0;
  let rewardGranted = false;

  if (!alreadyClaimedToday) {
    const continuesStreak = currentRewardState.lastClaimDate === yesterday;
    nextStreakDays = continuesStreak ? currentRewardState.streakDays + 1 : 1;
    rewardAmount = getDailyRewardAmount(nextStreakDays);
    rewardGranted = rewardAmount > 0;

    await client.query(
      `
        insert into player_daily_login_rewards (
          player_id,
          streak_days,
          last_claim_date,
          last_reward_amount,
          total_claims
        )
        values ($1, $2, $3, $4, 1)
        on conflict (player_id) do update
          set streak_days = excluded.streak_days,
              last_claim_date = excluded.last_claim_date,
              last_reward_amount = excluded.last_reward_amount,
              total_claims = player_daily_login_rewards.total_claims + 1,
              updated_at = now()
      `,
      [playerId, nextStreakDays, today, rewardAmount]
    );

    if (rewardGranted) {
      const playerAccount = await lockPlayerDracoAccount(client, playerId);
      if (!playerAccount) {
        throw new Error(`Unable to lock DRACO account for player ${playerId}`);
      }

      const currentBalance = BigInt(playerAccount.balance);
      const nextBalance = currentBalance + BigInt(rewardAmount);

      await client.query(
        `
          update accounts
          set balance = $2,
              updated_at = now()
          where id = $1
        `,
        [playerAccount.id, nextBalance.toString()]
      );

      await client.query(
        `
          insert into draco_transactions (
            to_account_id,
            amount,
            transaction_type,
            status,
            reason,
            metadata,
            created_by_player_id,
            server_id
          )
          values (
            $1, $2, 'reward', 'confirmed', 'daily_login', $3::jsonb, $4, $5
          )
        `,
        [
          playerAccount.id,
          rewardAmount.toString(),
          JSON.stringify({
            source: "daily_login",
            timezone: LOGIN_REWARD_TIMEZONE,
            claimedOn: today,
            streakDays: nextStreakDays,
            rewardCycleDay: getDailyRewardCycleDay(nextStreakDays)
          }),
          playerId,
          serverId
        ]
      );
    }
  }

  const activity = await getDailyLoginActivity(client, today, sevenDayWindowStart);
  const streakDays = alreadyClaimedToday ? currentRewardState.streakDays : nextStreakDays;
  const rewardCycleDay = getDailyRewardCycleDay(streakDays);
  const nextRewardAmount = getDailyRewardAmount(streakDays + 1);

  return {
    rewardGranted,
    rewardAmount,
    claimedToday: alreadyClaimedToday || rewardGranted,
    streakDays,
    rewardCycleDay,
    nextRewardAmount,
    activePlayersToday: Number(activity.activePlayersToday ?? 0),
    activePlayers7d: Number(activity.activePlayers7d ?? 0),
    weeklyCycleLength: DAILY_LOGIN_REWARD_SCHEDULE.length
  } satisfies DailyLoginRewardStatus;
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
          coalesce(p.class_name, 'Cidadao') as "className",
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
  if (!profile) return null;

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

  const row = { ...profile, ...inventory };

  return row;
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

    const dailyLoginReward = await applyDailyLoginReward(client, playerId, serverId);

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
      state: state
        ? {
            ...state,
            dailyLoginReward
          }
        : null,
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
    const presenceResult = await client.query<{
      currentServerId: string | null;
      online: boolean;
      lastInventoryVersion: string;
    }>(
      `
        select
          current_server_id as "currentServerId",
          online,
          last_inventory_version as "lastInventoryVersion"
        from player_server_presence
        where player_id = $1
        for update
      `,
      [playerId]
    );
    const currentPresence = presenceResult.rows[0] ?? null;

    const metadataResult = await client.query<{ metadata: Record<string, unknown> | null }>(
      `
        select metadata
        from player_inventories
        where player_id = $1
        limit 1
        for update
      `,
      [playerId]
    );
    const storedMetadata =
      metadataResult.rows[0]?.metadata && typeof metadataResult.rows[0].metadata === "object"
        ? metadataResult.rows[0].metadata
        : {};
    const payloadMetadata = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
    const mergedMetadata = {
      ...storedMetadata,
      ...payloadMetadata,
      racePowerCooldowns: {
        ...(storedMetadata.racePowerCooldowns && typeof storedMetadata.racePowerCooldowns === "object"
          ? (storedMetadata.racePowerCooldowns as Record<string, unknown>)
          : {}),
        ...(payloadMetadata.racePowerCooldowns && typeof payloadMetadata.racePowerCooldowns === "object"
          ? (payloadMetadata.racePowerCooldowns as Record<string, unknown>)
          : {})
      }
    };

    if (
      currentPresence?.online &&
      currentPresence.currentServerId &&
      currentPresence.currentServerId !== serverId
    ) {
      console.warn(
        `[PLAYER_SYNC] Ignorando save atrasado de ${payload.gamertag} em ${payload.serverSlug}; sessao ativa em outro servidor.`
      );
      await client.query("commit");
      return {
        playerId,
        inventoryVersion: Number(currentPresence.lastInventoryVersion ?? 0),
        accepted: false,
        reason: "stale_server_write"
      };
    }

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
        JSON.stringify(mergedMetadata),
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
          metadata: mergedMetadata
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
            last_left_at = case
              when current_server_id = $2 then now()
              else last_left_at
            end,
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

export async function reserveRacePowerCooldown(payload: RacePowerPayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const serverId = await findServerId(client, payload.serverSlug);
    const playerId = await ensurePlayer(client, payload);
    await ensurePlayerAccount(client, playerId);

    const inventoryResult = await client.query<{ metadata: Record<string, unknown> | null }>(
      `
        select metadata
        from player_inventories
        where player_id = $1
        limit 1
        for update
      `,
      [playerId]
    );

    const currentMetadata =
      inventoryResult.rows[0]?.metadata && typeof inventoryResult.rows[0].metadata === "object"
        ? inventoryResult.rows[0].metadata
        : {};

    const currentCooldowns =
      currentMetadata.racePowerCooldowns && typeof currentMetadata.racePowerCooldowns === "object"
        ? (currentMetadata.racePowerCooldowns as Record<string, unknown>)
        : {};

    const now = Date.now();
    const normalizedRaceKey = String(payload.raceKey || "").trim().toLowerCase();
    const currentCooldown = Number(currentCooldowns[normalizedRaceKey] ?? 0);

    if (Number.isFinite(currentCooldown) && currentCooldown > now) {
      await client.query("commit");
      return {
        ok: false,
        reason: "cooldown_active",
        nextAvailableAt: currentCooldown,
        remainingMs: currentCooldown - now
      };
    }

    const nextAvailableAt = now + Number(payload.cooldownMs);
    const nextMetadata = {
      ...currentMetadata,
      racePowerCooldowns: {
        ...currentCooldowns,
        [normalizedRaceKey]: nextAvailableAt
      }
    };

    await client.query(
      `
        insert into player_inventories (
          player_id,
          metadata,
          updated_by_server_id,
          updated_at
        )
        values ($1, $2::jsonb, $3, now())
        on conflict (player_id) do update
          set metadata = excluded.metadata,
              updated_by_server_id = excluded.updated_by_server_id,
              updated_at = now()
      `,
      [playerId, JSON.stringify(nextMetadata), serverId]
    );

    await client.query("commit");
    return {
      ok: true,
      nextAvailableAt,
      remainingMs: Number(payload.cooldownMs)
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
