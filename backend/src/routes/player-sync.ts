import { FastifyInstance } from "fastify";

import {
  getPlayerState,
  handleJoin,
  handleLeave,
  inventoryPayloadSchema,
  joinPayloadSchema,
  leavePayloadSchema,
  statePayloadSchema,
  saveInventory
} from "../services/player-sync.js";

export async function registerPlayerSyncRoutes(app: FastifyInstance) {
  app.post("/internal/player-sync/join", async (request, reply) => {
    const parsed = joinPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    const state = await handleJoin(parsed.data);
    return reply.status(200).send(state);
  });

  app.post("/internal/player-sync/state", async (request, reply) => {
    const parsed = statePayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    const state = await getPlayerState(parsed.data);
    if (!state) {
      return reply.status(404).send({
        error: "player_not_found"
      });
    }

    return reply.status(200).send(state);
  });

  app.post("/internal/player-sync/inventory", async (request, reply) => {
    const parsed = inventoryPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    const result = await saveInventory(parsed.data);
    return reply.status(200).send(result);
  });

  app.post("/internal/player-sync/leave", async (request, reply) => {
    const parsed = leavePayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    const result = await handleLeave(parsed.data);
    return reply.status(200).send(result);
  });
}
