import { PoolClient } from "pg";
import { z } from "zod";

import { config } from "../config.js";
import { pool } from "../lib/db.js";
import { rejectGamertagFallbackXuid } from "../lib/player-identity.js";
import { isAdmin } from "./admin.js";

export const transferPayloadSchema = z.object({
  xuid: z.string().min(1),
  gamertag: z.string().min(1),
  serverSlug: z.string().min(1),
  legacyXuids: z.array(z.string().min(1)).default([]),
  targetGamertag: z.string().min(1),
  amount: z.number().int().positive(),
  reason: z.string().trim().max(120).optional()
}).superRefine(rejectGamertagFallbackXuid);

export const mintPayloadSchema = z.object({
  xuid: z.string().min(1),
  gamertag: z.string().min(1),
  serverSlug: z.string().min(1),
  legacyXuids: z.array(z.string().min(1)).default([]),
  targetGamertag: z.string().min(1),
  amount: z.number().int().positive(),
  reason: z.string().trim().max(50).optional()
}).superRefine(rejectGamertagFallbackXuid);

type TransferPayload = z.infer<typeof transferPayloadSchema>;
type MintPayload = z.infer<typeof mintPayloadSchema>;

type PlayerIdentityRow = {
  id: string;
  gamertag: string;
};

type AccountRow = {
  id: string;
  playerId: string;
  balance: string;
};

export class EconomyServiceError extends Error {
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
    this.name = "EconomyServiceError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

function createEconomyError(
  statusCode: number,
  errorCode: string,
  message: string,
  details?: Record<string, unknown>
) {
  return new EconomyServiceError(statusCode, errorCode, message, details);
}

function normalizeGamertag(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function toSafeNumber(value: bigint) {
  const numericValue = Number(value);
  if (!Number.isSafeInteger(numericValue)) {
    throw createEconomyError(500, "balance_out_of_range", "Balance is outside the safe numeric range.");
  }

  return numericValue;
}

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
    throw createEconomyError(404, "server_not_found", `Unknown server slug: ${serverSlug}`);
  }

  return serverResult.rows[0].id;
}

async function ensurePlayer(
  client: PoolClient,
  payload: Pick<TransferPayload, "xuid" | "gamertag" | "legacyXuids">
) {
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

async function findPlayerByGamertag(client: PoolClient, gamertag: string) {
  const normalizedGamertag = normalizeGamertag(gamertag);
  const playerResult = await client.query<PlayerIdentityRow>(
    `
      select id, gamertag
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

async function lockPlayerAccounts(client: PoolClient, playerIds: string[]) {
  const accountResult = await client.query<AccountRow>(
    `
      select
        id,
        player_id as "playerId",
        balance
      from accounts
      where currency_code = 'DRACO'
        and player_id = any($1::uuid[])
      order by player_id
      for update
    `,
    [playerIds]
  );

  return new Map(accountResult.rows.map((row) => [row.playerId, row]));
}

export async function transferDraco(payload: TransferPayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    const serverId = await findServerId(client, payload.serverSlug);
    const senderId = await ensurePlayer(client, payload);
    const recipient = await findPlayerByGamertag(client, payload.targetGamertag);

    if (!recipient) {
      throw createEconomyError(
        404,
        "recipient_not_found",
        `Player ${payload.targetGamertag} was not found in the database.`
      );
    }

    if (recipient.id === senderId) {
      throw createEconomyError(400, "cannot_pay_self", "You cannot pay yourself.");
    }

    await ensurePlayerAccount(client, senderId);
    await ensurePlayerAccount(client, recipient.id);

    const accountsByPlayerId = await lockPlayerAccounts(client, [senderId, recipient.id]);
    const senderAccount = accountsByPlayerId.get(senderId);
    const recipientAccount = accountsByPlayerId.get(recipient.id);

    if (!senderAccount || !recipientAccount) {
      throw createEconomyError(500, "account_not_found", "Unable to load one or more player accounts.");
    }

    const transferAmount = BigInt(payload.amount);
    const senderBalance = BigInt(senderAccount.balance);
    const recipientBalance = BigInt(recipientAccount.balance);

    const isSenderAdmin = isAdmin(payload.gamertag, payload.xuid);

    if (!isSenderAdmin && senderBalance < transferAmount) {
      throw createEconomyError(409, "insufficient_funds", "Insufficient funds.", {
        currentBalance: toSafeNumber(senderBalance)
      });
    }

    const nextSenderBalance = isSenderAdmin ? senderBalance : senderBalance - transferAmount;
    const nextRecipientBalance = recipientBalance + transferAmount;

    if (!isSenderAdmin) {
      await client.query(
        `
          update accounts
          set balance = $2,
              updated_at = now()
          where id = $1
        `,
        [senderAccount.id, nextSenderBalance.toString()]
      );
    }

    await client.query(
      `
        update accounts
        set balance = $2,
            updated_at = now()
        where id = $1
      `,
      [recipientAccount.id, nextRecipientBalance.toString()]
    );

    const transactionResult = await client.query<{ id: string }>(
      `
        insert into draco_transactions (
          from_account_id,
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
          $1, $2, $3, 'transfer', 'confirmed', $4, $5::jsonb, $6, $7
        )
        returning id
      `,
      [
        senderAccount.id,
        recipientAccount.id,
        transferAmount.toString(),
        payload.reason?.trim() || "command_pay",
        JSON.stringify({
          senderGamertag: payload.gamertag,
          recipientGamertag: recipient.gamertag,
          source: "command_pay"
        }),
        senderId,
        serverId
      ]
    );

    await client.query("commit");

    return {
      transactionId: transactionResult.rows[0].id,
      amount: toSafeNumber(transferAmount),
      senderBalance: toSafeNumber(nextSenderBalance),
      recipientBalance: toSafeNumber(nextRecipientBalance),
      recipientGamertag: recipient.gamertag
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function mintDraco(payload: MintPayload) {
  const client = await pool.connect();

  try {
    await client.query("begin");

    // Verificar se quem está pedindo é Admin
    if (!isAdmin(payload.gamertag, payload.xuid)) {
      throw createEconomyError(403, "forbidden", "Only admins can mint Dracos.");
    }

    const serverId = await findServerId(client, payload.serverSlug);
    const actorId = await ensurePlayer(client, payload);
    const recipient = await findPlayerByGamertag(client, payload.targetGamertag);

    if (!recipient) {
      throw createEconomyError(
        404,
        "recipient_not_found",
        `Player ${payload.targetGamertag} was not found.`
      );
    }

    await ensurePlayerAccount(client, recipient.id);

    const accountsByPlayerId = await lockPlayerAccounts(client, [recipient.id]);
    const recipientAccount = accountsByPlayerId.get(recipient.id);

    if (!recipientAccount) {
      throw createEconomyError(500, "account_not_found", "Unable to load recipient account.");
    }

    const mintAmount = BigInt(payload.amount);
    const recipientBalance = BigInt(recipientAccount.balance);
    const nextRecipientBalance = recipientBalance + mintAmount;

    await client.query(
      `
        update accounts
        set balance = $2,
            updated_at = now()
        where id = $1
      `,
      [recipientAccount.id, nextRecipientBalance.toString()]
    );

    const transactionResult = await client.query<{ id: string }>(
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
          $1, $2, 'mint', 'confirmed', $3, $4::jsonb, $5, $6
        )
        returning id
      `,
      [
        recipientAccount.id,
        mintAmount.toString(),
        payload.reason?.trim() || "admin_mint",
        JSON.stringify({
          adminGamertag: payload.gamertag,
          recipientGamertag: recipient.gamertag,
          source: "admin_command"
        }),
        actorId,
        serverId
      ]
    );

    await client.query("commit");

    return {
      transactionId: transactionResult.rows[0].id,
      amount: toSafeNumber(mintAmount),
      recipientBalance: toSafeNumber(nextRecipientBalance),
      recipientGamertag: recipient.gamertag
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Busca os jogadores com os maiores saldos de Dracos.
 */
export async function getTopRicos(limit: number = 10) {
  const adminGamertags = config.ADMIN_COMMAND_GAMERTAGS;

  const accountResult = await pool.query<{ gamertag: string; balance: string }>(
    `
      select
        p.gamertag,
        a.balance
      from accounts a
      inner join players p on p.id = a.player_id
      where a.currency_code = 'DRACO'
        and not (lower(p.gamertag) = any($2::text[]))
      order by (a.balance)::numeric desc
      limit $1
    `,
    [limit, adminGamertags.map(g => g.toLowerCase())]
  );

  return accountResult.rows.map(row => ({
    gamertag: row.gamertag,
    balance: Number(row.balance)
  }));
}
