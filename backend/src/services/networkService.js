import crypto from 'node:crypto';
import { SESSION_TTL_SECONDS } from '../config.js';
import { withTransaction } from '../db.js';

function createHttpError(status, code, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) {
    error.details = details;
  }
  return error;
}

function normalizePlayerId(playerId) {
  const normalized = String(playerId || '').trim().toLowerCase();
  if (!normalized) {
    throw createHttpError(400, 'INVALID_PLAYER_ID', 'playerId is required.');
  }

  return normalized;
}

function normalizeDisplayName(displayName, playerId) {
  const value = String(displayName || '').trim();
  return value || playerId;
}

function defaultProfile(displayName) {
  return {
    version: 1,
    displayName,
    clan: null,
    classKey: null,
    skills: {},
    metadata: {}
  };
}

function defaultInventory() {
  return {
    slots: [],
    equipment: {}
  };
}

function sanitizeProfile(profile, displayName) {
  const value = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  const base = defaultProfile(displayName);
  const metadata =
    value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? value.metadata
      : {};
  const skills =
    value.skills && typeof value.skills === 'object' && !Array.isArray(value.skills)
      ? value.skills
      : {};

  return {
    ...base,
    ...value,
    displayName,
    skills,
    metadata
  };
}

function sanitizeInventory(inventory) {
  const value = inventory && typeof inventory === 'object' && !Array.isArray(inventory) ? inventory : {};
  const slots = Array.isArray(value.slots) ? value.slots : [];
  const equipment =
    value.equipment && typeof value.equipment === 'object' && !Array.isArray(value.equipment)
      ? value.equipment
      : {};

  return {
    slots,
    equipment
  };
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return fallback;
    }
  }

  return value;
}

function isSessionExpired(sessionRow) {
  if (!sessionRow?.lease_expires_at) {
    return true;
  }

  return new Date(sessionRow.lease_expires_at).getTime() <= Date.now();
}

function nextLeaseExpiry() {
  return new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
}

async function recordServerPresence(connection, serverId) {
  await connection.query(
    `
      INSERT INTO servers (server_id, last_seen_at)
      VALUES (?, CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP(3)
    `,
    [serverId]
  );
}

async function ensurePlayerRows(connection, playerId, displayName) {
  const safeDisplayName = normalizeDisplayName(displayName, playerId);

  await connection.query(
    `
      INSERT INTO player_profiles (
        player_id,
        display_name,
        profile_json,
        revision,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)
    `,
    [playerId, safeDisplayName, JSON.stringify(defaultProfile(safeDisplayName))]
  );

  await connection.query(
    `
      INSERT INTO player_inventories (
        player_id,
        inventory_json,
        revision,
        created_at,
        updated_at
      )
      VALUES (?, ?, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE updated_at = updated_at
    `,
    [playerId, JSON.stringify(defaultInventory())]
  );

  await connection.query(
    `
      INSERT INTO player_balances (
        player_id,
        balance,
        revision,
        created_at,
        updated_at
      )
      VALUES (?, 0, 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE updated_at = updated_at
    `,
    [playerId]
  );
}

async function loadBundle(connection, playerId) {
  const [profileRows] = await connection.query(
    `
      SELECT display_name, profile_json, revision, updated_at, last_server_id
      FROM player_profiles
      WHERE player_id = ?
    `,
    [playerId]
  );

  const [inventoryRows] = await connection.query(
    `
      SELECT inventory_json, revision, updated_at, last_server_id
      FROM player_inventories
      WHERE player_id = ?
    `,
    [playerId]
  );

  const [balanceRows] = await connection.query(
    `
      SELECT balance, revision, updated_at, last_server_id
      FROM player_balances
      WHERE player_id = ?
    `,
    [playerId]
  );

  const profileRow = profileRows[0];
  const inventoryRow = inventoryRows[0];
  const balanceRow = balanceRows[0];

  return {
    profile: {
      revision: profileRow?.revision ?? 0,
      updatedAt: profileRow?.updated_at ?? null,
      lastServerId: profileRow?.last_server_id ?? null,
      data: sanitizeProfile(
        parseJsonColumn(profileRow?.profile_json, defaultProfile(profileRow?.display_name ?? playerId)),
        profileRow?.display_name ?? playerId
      )
    },
    inventory: {
      revision: inventoryRow?.revision ?? 0,
      updatedAt: inventoryRow?.updated_at ?? null,
      lastServerId: inventoryRow?.last_server_id ?? null,
      data: sanitizeInventory(parseJsonColumn(inventoryRow?.inventory_json, defaultInventory()))
    },
    economy: {
      revision: balanceRow?.revision ?? 0,
      updatedAt: balanceRow?.updated_at ?? null,
      lastServerId: balanceRow?.last_server_id ?? null,
      balance: Number(balanceRow?.balance ?? 0)
    }
  };
}

async function assertOwnedSession(connection, { playerId, serverId, sessionToken, lock = false }) {
  const sql = `
    SELECT player_id, server_id, session_token, lease_expires_at
    FROM player_sessions
    WHERE player_id = ?
    ${lock ? 'FOR UPDATE' : ''}
  `;

  const [rows] = await connection.query(sql, [playerId]);
  const sessionRow = rows[0];

  if (!sessionRow) {
    throw createHttpError(409, 'SESSION_NOT_FOUND', 'Player session was not found.');
  }

  if (sessionRow.server_id !== serverId) {
    throw createHttpError(409, 'SESSION_OWNED_BY_OTHER_SERVER', 'Player session belongs to another server.', {
      currentServerId: sessionRow.server_id
    });
  }

  if (sessionRow.session_token !== sessionToken) {
    throw createHttpError(409, 'SESSION_TOKEN_MISMATCH', 'Session token does not match.');
  }

  if (isSessionExpired(sessionRow)) {
    throw createHttpError(409, 'SESSION_EXPIRED', 'Player session has expired.');
  }

  return sessionRow;
}

export async function heartbeatServer(serverId) {
  return withTransaction(async (connection) => {
    await recordServerPresence(connection, serverId);
    return {
      status: 'ok',
      serverId,
      seenAt: new Date().toISOString()
    };
  });
}

export async function connectPlayerSession({ serverId, playerId, displayName }) {
  const normalizedPlayerId = normalizePlayerId(playerId);

  return withTransaction(async (connection) => {
    const safeDisplayName = normalizeDisplayName(displayName, normalizedPlayerId);
    await recordServerPresence(connection, serverId);
    await ensurePlayerRows(connection, normalizedPlayerId, safeDisplayName);

    const [sessionRows] = await connection.query(
      `
        SELECT player_id, server_id, session_token, lease_expires_at
        FROM player_sessions
        WHERE player_id = ?
        FOR UPDATE
      `,
      [normalizedPlayerId]
    );

    const currentSession = sessionRows[0];
    if (currentSession && currentSession.server_id !== serverId && !isSessionExpired(currentSession)) {
      throw createHttpError(
        409,
        'PLAYER_ALREADY_CONNECTED',
        'Player is already connected on another server.',
        {
          currentServerId: currentSession.server_id,
          leaseExpiresAt: currentSession.lease_expires_at
        }
      );
    }

    const sessionToken = crypto.randomUUID();
    const leaseExpiresAt = nextLeaseExpiry();

    await connection.query(
      `
        INSERT INTO player_sessions (
          player_id,
          server_id,
          session_token,
          lease_expires_at,
          connected_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          server_id = VALUES(server_id),
          session_token = VALUES(session_token),
          lease_expires_at = VALUES(lease_expires_at),
          updated_at = CURRENT_TIMESTAMP(3)
      `,
      [normalizedPlayerId, serverId, sessionToken, leaseExpiresAt]
    );

    return {
      playerId: normalizedPlayerId,
      sessionToken,
      leaseExpiresAt,
      bundle: await loadBundle(connection, normalizedPlayerId)
    };
  });
}

export async function loadPlayerBundle({ serverId, playerId, sessionToken }) {
  const normalizedPlayerId = normalizePlayerId(playerId);

  return withTransaction(async (connection) => {
    await recordServerPresence(connection, serverId);
    await assertOwnedSession(connection, {
      playerId: normalizedPlayerId,
      serverId,
      sessionToken
    });

    return {
      playerId: normalizedPlayerId,
      bundle: await loadBundle(connection, normalizedPlayerId)
    };
  });
}

export async function heartbeatPlayerSession({ serverId, playerId, sessionToken }) {
  const normalizedPlayerId = normalizePlayerId(playerId);

  return withTransaction(async (connection) => {
    await recordServerPresence(connection, serverId);
    await assertOwnedSession(connection, {
      playerId: normalizedPlayerId,
      serverId,
      sessionToken,
      lock: true
    });

    const leaseExpiresAt = nextLeaseExpiry();
    await connection.query(
      `
        UPDATE player_sessions
        SET lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP(3)
        WHERE player_id = ?
      `,
      [leaseExpiresAt, normalizedPlayerId]
    );

    return {
      playerId: normalizedPlayerId,
      leaseExpiresAt
    };
  });
}

export async function disconnectPlayerSession({ serverId, playerId, sessionToken }) {
  const normalizedPlayerId = normalizePlayerId(playerId);

  return withTransaction(async (connection) => {
    await recordServerPresence(connection, serverId);
    await assertOwnedSession(connection, {
      playerId: normalizedPlayerId,
      serverId,
      sessionToken,
      lock: true
    });

    await connection.query('DELETE FROM player_sessions WHERE player_id = ?', [normalizedPlayerId]);

    return {
      playerId: normalizedPlayerId,
      disconnected: true
    };
  });
}

export async function savePlayerProfile({
  serverId,
  playerId,
  sessionToken,
  displayName,
  profile,
  expectedRevision = null
}) {
  const normalizedPlayerId = normalizePlayerId(playerId);

  return withTransaction(async (connection) => {
    const safeDisplayName = normalizeDisplayName(displayName, normalizedPlayerId);
    await recordServerPresence(connection, serverId);
    await ensurePlayerRows(connection, normalizedPlayerId, safeDisplayName);
    await assertOwnedSession(connection, {
      playerId: normalizedPlayerId,
      serverId,
      sessionToken,
      lock: true
    });

    const [rows] = await connection.query(
      `
        SELECT revision
        FROM player_profiles
        WHERE player_id = ?
        FOR UPDATE
      `,
      [normalizedPlayerId]
    );

    const currentRevision = Number(rows[0]?.revision ?? 0);
    if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
      throw createHttpError(409, 'PROFILE_REVISION_CONFLICT', 'Profile revision conflict.', {
        expectedRevision: Number(expectedRevision),
        currentRevision
      });
    }

    const safeProfile = sanitizeProfile(profile, safeDisplayName);
    await connection.query(
      `
        UPDATE player_profiles
        SET
          display_name = ?,
          profile_json = ?,
          revision = revision + 1,
          last_server_id = ?,
          updated_at = CURRENT_TIMESTAMP(3)
        WHERE player_id = ?
      `,
      [safeDisplayName, JSON.stringify(safeProfile), serverId, normalizedPlayerId]
    );

    const bundle = await loadBundle(connection, normalizedPlayerId);
    return {
      playerId: normalizedPlayerId,
      profile: bundle.profile
    };
  });
}

export async function savePlayerInventory({
  serverId,
  playerId,
  sessionToken,
  inventory,
  expectedRevision = null
}) {
  const normalizedPlayerId = normalizePlayerId(playerId);

  return withTransaction(async (connection) => {
    await recordServerPresence(connection, serverId);
    await ensurePlayerRows(connection, normalizedPlayerId, normalizedPlayerId);
    await assertOwnedSession(connection, {
      playerId: normalizedPlayerId,
      serverId,
      sessionToken,
      lock: true
    });

    const [rows] = await connection.query(
      `
        SELECT revision
        FROM player_inventories
        WHERE player_id = ?
        FOR UPDATE
      `,
      [normalizedPlayerId]
    );

    const currentRevision = Number(rows[0]?.revision ?? 0);
    if (expectedRevision !== null && expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
      throw createHttpError(409, 'INVENTORY_REVISION_CONFLICT', 'Inventory revision conflict.', {
        expectedRevision: Number(expectedRevision),
        currentRevision
      });
    }

    const safeInventory = sanitizeInventory(inventory);
    await connection.query(
      `
        UPDATE player_inventories
        SET
          inventory_json = ?,
          revision = revision + 1,
          last_server_id = ?,
          updated_at = CURRENT_TIMESTAMP(3)
        WHERE player_id = ?
      `,
      [JSON.stringify(safeInventory), serverId, normalizedPlayerId]
    );

    const bundle = await loadBundle(connection, normalizedPlayerId);
    return {
      playerId: normalizedPlayerId,
      inventory: bundle.inventory
    };
  });
}

export async function adjustPlayerBalance({
  serverId,
  playerId,
  sessionToken,
  amount,
  reason,
  metadata = null
}) {
  const normalizedPlayerId = normalizePlayerId(playerId);
  const delta = Number(amount);

  if (!Number.isFinite(delta) || delta === 0) {
    throw createHttpError(400, 'INVALID_AMOUNT', 'amount must be a non-zero number.');
  }

  return withTransaction(async (connection) => {
    await recordServerPresence(connection, serverId);
    await ensurePlayerRows(connection, normalizedPlayerId, normalizedPlayerId);
    await assertOwnedSession(connection, {
      playerId: normalizedPlayerId,
      serverId,
      sessionToken,
      lock: true
    });

    const [rows] = await connection.query(
      `
        SELECT balance
        FROM player_balances
        WHERE player_id = ?
        FOR UPDATE
      `,
      [normalizedPlayerId]
    );

    const currentBalance = Number(rows[0]?.balance ?? 0);
    const nextBalance = currentBalance + delta;
    if (nextBalance < 0) {
      throw createHttpError(409, 'INSUFFICIENT_FUNDS', 'Player balance cannot become negative.', {
        currentBalance
      });
    }

    await connection.query(
      `
        UPDATE player_balances
        SET
          balance = ?,
          revision = revision + 1,
          last_server_id = ?,
          updated_at = CURRENT_TIMESTAMP(3)
        WHERE player_id = ?
      `,
      [nextBalance, serverId, normalizedPlayerId]
    );

    await connection.query(
      `
        INSERT INTO economy_transactions (
          player_id,
          counterparty_player_id,
          amount,
          balance_after,
          reason,
          server_id,
          metadata_json
        )
        VALUES (?, NULL, ?, ?, ?, ?, ?)
      `,
      [
        normalizedPlayerId,
        delta,
        nextBalance,
        String(reason || 'adjustment'),
        serverId,
        metadata ? JSON.stringify(metadata) : null
      ]
    );

    const bundle = await loadBundle(connection, normalizedPlayerId);
    return {
      playerId: normalizedPlayerId,
      economy: bundle.economy
    };
  });
}

export async function transferPlayerBalance({
  serverId,
  fromPlayerId,
  toPlayerId,
  sessionToken,
  amount,
  reason,
  metadata = null
}) {
  const fromId = normalizePlayerId(fromPlayerId);
  const toId = normalizePlayerId(toPlayerId);
  const value = Number(amount);

  if (fromId === toId) {
    throw createHttpError(400, 'INVALID_TRANSFER', 'Source and target players must be different.');
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw createHttpError(400, 'INVALID_AMOUNT', 'amount must be greater than zero.');
  }

  return withTransaction(async (connection) => {
    await recordServerPresence(connection, serverId);
    await ensurePlayerRows(connection, fromId, fromId);
    await ensurePlayerRows(connection, toId, toId);
    await assertOwnedSession(connection, {
      playerId: fromId,
      serverId,
      sessionToken,
      lock: true
    });

    const lockedOrder = [fromId, toId].sort();
    const [rows] = await connection.query(
      `
        SELECT player_id, balance
        FROM player_balances
        WHERE player_id IN (?, ?)
        FOR UPDATE
      `,
      lockedOrder
    );

    const byId = new Map(rows.map((row) => [row.player_id, Number(row.balance)]));
    const fromBalance = byId.get(fromId) ?? 0;
    const toBalance = byId.get(toId) ?? 0;

    if (fromBalance < value) {
      throw createHttpError(409, 'INSUFFICIENT_FUNDS', 'Source player does not have enough balance.', {
        currentBalance: fromBalance
      });
    }

    const nextFromBalance = fromBalance - value;
    const nextToBalance = toBalance + value;

    await connection.query(
      `
        UPDATE player_balances
        SET
          balance = ?,
          revision = revision + 1,
          last_server_id = ?,
          updated_at = CURRENT_TIMESTAMP(3)
        WHERE player_id = ?
      `,
      [nextFromBalance, serverId, fromId]
    );

    await connection.query(
      `
        UPDATE player_balances
        SET
          balance = ?,
          revision = revision + 1,
          last_server_id = ?,
          updated_at = CURRENT_TIMESTAMP(3)
        WHERE player_id = ?
      `,
      [nextToBalance, serverId, toId]
    );

    await connection.query(
      `
        INSERT INTO economy_transactions (
          player_id,
          counterparty_player_id,
          amount,
          balance_after,
          reason,
          server_id,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [fromId, toId, -value, nextFromBalance, String(reason || 'transfer'), serverId, metadata ? JSON.stringify(metadata) : null]
    );

    await connection.query(
      `
        INSERT INTO economy_transactions (
          player_id,
          counterparty_player_id,
          amount,
          balance_after,
          reason,
          server_id,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [toId, fromId, value, nextToBalance, String(reason || 'transfer'), serverId, metadata ? JSON.stringify(metadata) : null]
    );

    return {
      from: {
        playerId: fromId,
        balance: nextFromBalance
      },
      to: {
        playerId: toId,
        balance: nextToBalance
      }
    };
  });
}

export function formatError(error) {
  return {
    status: 'error',
    code: error.code || 'INTERNAL_ERROR',
    message: error.message || 'Unexpected error.',
    details: error.details || null
  };
}

export function getErrorStatus(error) {
  return error.status || 500;
}
