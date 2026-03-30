import Fastify from "fastify";
import cors from "@fastify/cors";

import { registerEconomyRoutes } from "./routes/economy.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerKingdomRoutes } from "./routes/kingdoms.js";
import { registerNationManagementRoutes } from "./routes/nation-management.js";
import { registerNationRoutes } from "./routes/nations.js";
import { registerPlayerSyncRoutes } from "./routes/player-sync.js";

export async function buildServer() {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: true
  });

  await registerHealthRoutes(app);
  await registerKingdomRoutes(app);
  await registerNationRoutes(app);
  await registerNationManagementRoutes(app);
  await registerPlayerSyncRoutes(app);
  await registerEconomyRoutes(app);

  app.setErrorHandler((error, _request, reply) => {
    const normalizedError = error instanceof Error ? error : new Error("Unknown server error");

    logError(normalizedError);

    reply.status(500).send({
      error: "internal_error",
      message: normalizedError.message
    });
  });

  return app;
}

function logError(error: Error) {
  console.error(error);
}
