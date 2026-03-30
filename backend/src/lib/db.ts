import pg from "pg";

import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.SUPABASE_DB_URL,
  max: config.DB_POOL_MAX,
  ssl: config.SUPABASE_DB_SSL ? { rejectUnauthorized: false } : false
});
