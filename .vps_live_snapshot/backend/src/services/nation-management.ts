import { PoolClient } from "pg";
import { z } from "zod";

import { config } from "../config.js";
import { pool } from "../lib/db.js";
import { rejectGamertagFallbackXuid } from "../lib/player-identity.js";
import { loadPlayerState } from "./player-sync.js";

const actorIdentitySchema = {
  xuid: z.string().min(1),
  gamertag: z.string().min(1),
  serverSlug: z.string().min(1),
  legacyXuids: z.array(z.string().min(1)).default([])
};

export const chooseNationPayloadSchema = z.object({
  ...actorIdentitySchema,
  nationSlug: z.string().min(1)
}).superRefine(rejectGamertagFallbackXuid);

export const chooseRacePayloadSchema = z.object({
  ...actorIdentitySchema,
  raceName: z.string().min(1)
}).superRefine(rejectGamertagFallbackXuid);

export const promoteMemberPayloadSchema = z.object({
  ...actorIdentitySchema,
  targetGamertag: z.string().min(1),
  className: z.string().min(1)
}).superRefine(rejectGamertagFallbackXuid);

export const demoteMemberPayloadSchema = z.object({
  ...actorIdentitySchema,
  targetGamertag: z.string().min(1)
}).superRefine(rejectGamertagFallbackXuid);

export const expelMemberPayloadSchema = z.object({
  ...actorIdentitySchema,
  targetGamertag: z.string().min(1)
}).superRefine(rejectGamertagFallbackXuid);

type ChooseNationPayload = z.infer<typeof chooseNationPayloadSchema>;
type ChooseRacePayload = z.infer<typeof chooseRacePayloadSchema>;
type PromoteMemberPayload = z.infer<typeof promoteMemberPayloadSchema>;
type DemoteMemberPayload = z.infer<typeof demoteMemberPayloadSchema>;
type ExpelMemberPayload = z.infer<typeof expelMemberPayloadSchema>;
type ActorPayload =
  | ChooseNationPayload
  | ChooseRacePayload
  | PromoteMemberPayload
  | DemoteMemberPayload
  | ExpelMemberPayload;

type PlayerIdentityRow = {
  id: string;
  gamertag: string;
  primaryNationId: string | null;
  className: string | null;
};

type NationRow = {
  id: string;
  slug: string;
  name: string;
};

type ActiveMembershipRow = {
  membershipId: string;
  nationId: string;
  nationSlug: string;
  nationName: string;
  role: string;
};

const RACE_CATALOG: Array<{
  canonicalName: string;
  aliases: string[];
}> = [
  {
    canonicalName: "Anão",
    aliases: ["anao", "anão", "dwarf"]
  },
  {
    canonicalName: "Elfo",
    aliases: ["elfo", "elf"]
  },
  {
    canonicalName: "Orc",
    aliases: ["orc"]
  },
  {
    canonicalName: "Celestial",
    aliases: ["celestial"]
  },
  {
    canonicalName: "Sombrio",
    aliases: ["sombrio", "shadow", "sombrio das sombras"]
  },
  {
    canonicalName: "Feral",
    aliases: ["feral", "selvagem"]
  }
];

const GLOBAL_CARGO_CATALOG: Array<{
  canonicalName: string;
  aliases: string[];
}> = [
  {
    canonicalName: "Cidadao",
    aliases: ["cidadao", "cidadão", "citizen"]
  },
  {
    canonicalName: "Cavaleiro",
    aliases: ["cavaleiro", "knight"]
  },
  {
    canonicalName: "Construtor",
    aliases: ["construtor", "builder"]
  },
  {
    canonicalName: "Lord",
    aliases: ["lord"]
  },
  {
    canonicalName: "Rei",
    aliases: ["rei", "king"]
  }
];

const LORD_ASSIGNABLE_CARGOS = new Set([
  "Cavaleiro",
  "Construtor"
]);

export class NationManagementError extends Error {
  statusCode: number;
  errorCode: string;
  details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    errorCode: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "NationManagementError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

function createNationError(
  statusCode: number,
  errorCode: string,
  message: string,
  details?: Record<string, unknown>
) {
  return new NationManagementError(statusCode, errorCode, message, details);
}

function normalizeText(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeGamertag(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function logRaceSelection(payload: ChooseRacePayload, stage: string, extra: Record<string, unknown> = {}) {
  try {
    console.warn(
      `[RACE_SELECT] ${JSON.stringify({
        stage,
        serverSlug: payload.serverSlug,
        gamertag: payload.gamertag,
        xuid: payload.xuid,
        raceName: payload.raceName,
        normalizedRaceName: normalizeText(payload.raceName),
        ...extra
      })}`
    );
  } catch (error) {
  }
}

function isAdminIdentity(xuid: string, gamertag: string) {
  const normalizedGamertag = normalizeText(gamertag);
  const normalizedXuid = String(xuid || "").trim();

  return (
    config.ADMIN_COMMAND_GAMERTAGS.some((entry) => normalizeText(entry) === normalizedGamertag) ||
    config.ADMIN_COMMAND_XUIDS.includes(normalizedXuid)
  );
}

function resolveCanonicalRaceName(raceName: string) {
  const normalizedRaceName = normalizeText(raceName);

  for (const entry of RACE_CATALOG) {
    if (
      normalizeText(entry.canonicalName) === normalizedRaceName ||
      entry.aliases.some((alias) => normalizeText(alias) === normalizedRaceName)
    ) {
      return entry.canonicalName;
    }
  }

  return null;
}

function resolveCanonicalCargoName(className: string) {
  const normalizedClassName = normalizeText(className);
  const entries = GLOBAL_CARGO_CATALOG;

  for (const entry of entries) {
    if (
      normalizeText(entry.canonicalName) === normalizedClassName ||
      entry.aliases.some((alias) => normalizeText(alias) === normalizedClassName)
    ) {
      return entry.canonicalName;
    }
  }

  return null;
}

function getMembershipRoleForCargo(cargoName: string) {
  return cargoName === "Lord" ? "leader" : "citizen";
}

async function ensurePlayer(client: PoolClient, payload: ActorPayload) {
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

async function findNationBySlug(client: PoolClient, nationSlug: string) {
  const nationResult = await client.query<NationRow>(
    `
      select id, slug, name
      from nations
      where slug = $1
      limit 1
    `,
    [normalizeText(nationSlug)]
  );

  return nationResult.rows[0] ?? null;
}

async function findPlayerByGamertag(client: PoolClient, gamertag: string) {
  const normalizedGamertag = normalizeGamertag(gamertag);
  const playerResult = await client.query<PlayerIdentityRow>(
    `
      select
        id,
        gamertag,
        primary_nation_id as "primaryNationId",
        class_name as "className"
      from players
      where lower(gamertag) = lower($1)
      order by
        case when gamertag = $1 then 0 else 1 end,
        last_seen_at desc nulls last,
        created_at asc
      limit 1
    `,
    [normalizedGamertag]
  );

  return playerResult.rows[0] ?? null;
}

async function findActiveNationMembership(client: PoolClient, playerId: string) {
  const membershipResult = await client.query<ActiveMembershipRow>(
    `
      select
        nm.id as "membershipId",
        nm.nation_id as "nationId",
        n.slug as "nationSlug",
        n.name as "nationName",
        nm.role
      from nation_memberships nm
      inner join nations n
        on n.id = nm.nation_id
      where nm.player_id = $1
        and nm.left_at is null
      limit 1
    `,
    [playerId]
  );

  return membershipResult.rows[0] ?? null;
}

async function assertManagementPermission(
  client: PoolClient,
  payload: PromoteMemberPayload | DemoteMemberPayload | ExpelMemberPayload,
  targetPlayerId: string
) {
  const actorPlayerId = await ensurePlayer(client, payload);
  const actorIsAdmin = isAdminIdentity(payload.xuid, payload.gamertag);

  if (actorPlayerId === targetPlayerId) {
    throw createNationError(400, "cannot_manage_self", "Você não pode usar este comando em si mesmo.");
  }

  const actorMembership = await findActiveNationMembership(client, actorPlayerId);
  const targetMembership = await findActiveNationMembership(client, targetPlayerId);

  if (!targetMembership) {
    throw createNationError(
      409,
      "target_without_nation",
      "O jogador informado ainda não pertence a nenhuma nação."
    );
  }

  if (actorIsAdmin) {
    return {
      actorPlayerId,
      actorIsAdmin,
      actorMembership,
      targetMembership
    };
  }

  if (!actorMembership || actorMembership.role !== "leader") {
    throw createNationError(
      403,
      "insufficient_permissions",
      "Apenas lordes da nação ou admins da rede podem usar este comando."
    );
  }

  if (actorMembership.nationId !== targetMembership.nationId) {
    throw createNationError(
      403,
      "cross_nation_management_denied",
      "Você só pode gerenciar membros da sua própria nação."
    );
  }

  if (targetMembership.role === "leader") {
    throw createNationError(
      403,
      "cannot_manage_leader",
      "Somente um admin da rede pode gerenciar outro lord."
    );
  }

  return {
    actorPlayerId,
    actorIsAdmin,
    actorMembership,
    targetMembership
  };
}

export async function chooseNation(payload: ChooseNationPayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const playerId = await ensurePlayer(client, payload);
    await ensurePlayerAccount(client, playerId);

    const existingMembership = await findActiveNationMembership(client, playerId);
    if (existingMembership) {
      throw createNationError(
        409,
        "nation_already_selected",
        "Você já escolheu uma nação para este personagem."
      );
    }

    const nation = await findNationBySlug(client, payload.nationSlug);
    if (!nation) {
      throw createNationError(404, "nation_not_found", `Unknown nation slug: ${payload.nationSlug}`);
    }

    await client.query(
      `
        insert into nation_memberships (player_id, nation_id, role)
        values ($1, $2, 'citizen')
      `,
      [playerId, nation.id]
    );

    await client.query(
      `
        update players
        set primary_nation_id = $2
            ,class_name = coalesce(class_name, 'Cidadao')
        where id = $1
      `,
      [playerId, nation.id]
    );

    const state = await loadPlayerState(client, playerId);

    await client.query("commit");

    return {
      nationSlug: nation.slug,
      nationName: nation.name,
      state
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function chooseRace(payload: ChooseRacePayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");
    logRaceSelection(payload, "attempt");

    const playerId = await ensurePlayer(client, payload);
    await ensurePlayerAccount(client, playerId);
    const canonicalRaceName = resolveCanonicalRaceName(payload.raceName);

    if (!canonicalRaceName) {
      logRaceSelection(payload, "race_not_found", {
        availableRaces: RACE_CATALOG.map((entry) => entry.canonicalName)
      });
      throw createNationError(400, "race_not_found", `Unknown race: ${payload.raceName}`);
    }

    const currentRaceResult = await client.query<{ race: string | null }>(
      `
        select race
        from players
        where id = $1
        limit 1
        for update
      `,
      [playerId]
    );

    const currentRace = String(currentRaceResult.rows[0]?.race || "").trim();
    if (currentRace) {
      logRaceSelection(payload, "race_already_selected", {
        currentRace
      });
      throw createNationError(
        409,
        "race_already_selected",
        "Você já escolheu uma raça para este personagem."
      );
    }

    await client.query(
      `
        update players
        set race = $2,
            class_name = coalesce(class_name, 'Cidadao')
        where id = $1
      `,
      [playerId, canonicalRaceName]
    );

    const state = await loadPlayerState(client, playerId);

    await client.query("commit");
    logRaceSelection(payload, "success", {
      canonicalRaceName
    });

    return {
      raceName: canonicalRaceName,
      state
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function promoteNationMember(payload: PromoteMemberPayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const targetPlayer = await findPlayerByGamertag(client, payload.targetGamertag);
    if (!targetPlayer) {
      throw createNationError(
        404,
        "target_not_found",
        `Player ${payload.targetGamertag} was not found in the database.`
      );
    }

    const { actorIsAdmin, targetMembership } = await assertManagementPermission(client, payload, targetPlayer.id);
    const canonicalClassName = resolveCanonicalCargoName(payload.className);

    if (!canonicalClassName) {
      throw createNationError(
        400,
        "invalid_cargo",
        "O cargo informado não é válido."
      );
    }

    if (!actorIsAdmin && !LORD_ASSIGNABLE_CARGOS.has(canonicalClassName)) {
      throw createNationError(
        403,
        "insufficient_permissions",
        "Somente admins podem promover para Lord ou Rei."
      );
    }

    await client.query(
      `
        update players
        set class_name = $2,
            primary_nation_id = coalesce(primary_nation_id, $3)
        where id = $1
      `,
      [targetPlayer.id, canonicalClassName, targetMembership.nationId]
    );

    await client.query(
      `
        update nation_memberships
        set role = $2
        where player_id = $1
          and left_at is null
      `,
      [targetPlayer.id, getMembershipRoleForCargo(canonicalClassName)]
    );

    const targetState = await loadPlayerState(client, targetPlayer.id);

    await client.query("commit");

    return {
      targetGamertag: targetPlayer.gamertag,
      className: canonicalClassName,
      nationSlug: targetMembership.nationSlug,
      nationName: targetMembership.nationName,
      targetState
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function demoteNationMember(payload: DemoteMemberPayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const targetPlayer = await findPlayerByGamertag(client, payload.targetGamertag);
    if (!targetPlayer) {
      throw createNationError(
        404,
        "target_not_found",
        `Player ${payload.targetGamertag} was not found in the database.`
      );
    }

    const { targetMembership } = await assertManagementPermission(client, payload, targetPlayer.id);

    await client.query(
      `
        update players
        set class_name = 'Cidadao'
        where id = $1
      `,
      [targetPlayer.id]
    );

    await client.query(
      `
        update nation_memberships
        set role = 'citizen'
        where player_id = $1
          and left_at is null
      `,
      [targetPlayer.id]
    );

    const targetState = await loadPlayerState(client, targetPlayer.id);

    await client.query("commit");

    return {
      targetGamertag: targetPlayer.gamertag,
      className: "Cidadao",
      nationSlug: targetMembership.nationSlug,
      nationName: targetMembership.nationName,
      targetState
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function expelNationMember(payload: ExpelMemberPayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const targetPlayer = await findPlayerByGamertag(client, payload.targetGamertag);
    if (!targetPlayer) {
      throw createNationError(
        404,
        "target_not_found",
        `Player ${payload.targetGamertag} was not found in the database.`
      );
    }

    const { targetMembership } = await assertManagementPermission(client, payload, targetPlayer.id);

    await client.query(
      `
        update clan_memberships
        set left_at = now()
        where player_id = $1
          and left_at is null
      `,
      [targetPlayer.id]
    );

    await client.query(
      `
        update nation_memberships
        set left_at = now()
        where player_id = $1
          and left_at is null
      `,
      [targetPlayer.id]
    );

    await client.query(
      `
        update players
        set class_name = 'Cidadao',
            primary_nation_id = null
        where id = $1
      `,
      [targetPlayer.id]
    );

    const targetState = await loadPlayerState(client, targetPlayer.id);

    await client.query("commit");

    return {
      targetGamertag: targetPlayer.gamertag,
      formerNationSlug: targetMembership.nationSlug,
      formerNationName: targetMembership.nationName,
      targetState
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
