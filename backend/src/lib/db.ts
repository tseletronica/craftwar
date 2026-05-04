import pg from "pg";
import type { Client as PgClient, QueryResult, QueryResultRow } from "pg";

import { config } from "../config.js";

const { Client } = pg;

const rawConfig = config as unknown as Record<string, unknown>;
const connectionString = String(
  process.env.SUPABASE_DB_URL ??
    rawConfig.SUPABASE_DB_URL ??
    rawConfig.DATABASE_URL ??
    ""
).trim();
const sslEnabled =
  process.env.SUPABASE_DB_SSL !== undefined
    ? process.env.SUPABASE_DB_SSL !== "false"
    : rawConfig.SUPABASE_DB_SSL !== undefined
      ? rawConfig.SUPABASE_DB_SSL !== false
      : rawConfig.DATABASE_SSL !== false;

const clientConfig = {
  connectionString,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false
};

type ManagedClient = PgClient & {
  release: () => void;
};

async function connect(): Promise<ManagedClient> {
  const client = new Client(clientConfig) as ManagedClient;
  await client.connect();
  client.release = () => {
    void client.end();
  };
  return client;
}

async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: readonly unknown[]
): Promise<QueryResult<R>> {
  const client = await connect();
  try {
    return await client.query<R>(text, values as unknown[] | undefined);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export const pool = {
  connect,
  query,
  end: async () => undefined
};
