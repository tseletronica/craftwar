import { z } from "zod";

function parseList(value: string | undefined) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(8080),
  SUPABASE_DB_URL: z.string().min(1, "SUPABASE_DB_URL is required"),
  SUPABASE_DB_SSL: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  ADMIN_COMMAND_GAMERTAGS: z.array(z.string().min(1)).default([]),
  ADMIN_COMMAND_XUIDS: z.array(z.string().min(1)).default([])
});

const parsed = envSchema.safeParse({
  NODE_ENV: process.env.NODE_ENV,
  API_PORT: process.env.API_PORT ?? 8080,
  SUPABASE_DB_URL: process.env.SUPABASE_DB_URL,
  SUPABASE_DB_SSL: process.env.SUPABASE_DB_SSL,
  DB_POOL_MAX: process.env.DB_POOL_MAX ?? 10,
  ADMIN_COMMAND_GAMERTAGS: parseList(
    process.env.ADMIN_COMMAND_GAMERTAGS ?? process.env.ADMIN_CREATIVE_GAMERTAGS
  ),
  ADMIN_COMMAND_XUIDS: parseList(
    process.env.ADMIN_COMMAND_XUIDS ?? process.env.ADMIN_OPERATOR_XUIDS
  )
});

if (!parsed.success) {
  console.error("Invalid environment configuration", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
