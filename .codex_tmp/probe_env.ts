import { config } from "./src/config.ts";

console.log(`env=${process.env.SUPABASE_DB_URL ?? ""}`);
console.log(`cfgKeys=${Object.keys(config).join(",")}`);
console.log(`cfgSupabase=${String((config as Record<string, unknown>).SUPABASE_DB_URL ?? "")}`);
console.log(`cfgDatabase=${String((config as Record<string, unknown>).DATABASE_URL ?? "")}`);
