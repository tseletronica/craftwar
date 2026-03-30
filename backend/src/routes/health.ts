import { FastifyInstance } from "fastify";

import { pool } from "../lib/db.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    const result = await pool.query<{ currentTime: string }>(
      `
        select now()::text as "currentTime"
      `
    );

    return {
      status: "ok",
      db: "up",
      currentTime: result.rows[0].currentTime
    };
  });
}
