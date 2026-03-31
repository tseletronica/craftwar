import { FastifyInstance } from "fastify";

import {
  EconomyServiceError,
  getTopRicos,
  mintDraco,
  mintPayloadSchema,
  transferDraco,
  transferPayloadSchema
} from "../services/economy.js";

export async function registerEconomyRoutes(app: FastifyInstance) {
  app.post("/internal/economy/transfer", async (request, reply) => {
    const parsed = transferPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    try {
      const result = await transferDraco(parsed.data);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof EconomyServiceError) {
        return reply.status(error.statusCode).send({
          error: error.errorCode,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        });
      }

      throw error;
    }
  });

  app.post("/internal/economy/mint", async (request, reply) => {
    const parsed = mintPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    try {
      const result = await mintDraco(parsed.data);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof EconomyServiceError) {
        return reply.status(error.statusCode).send({
          error: error.errorCode,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        });
      }

      throw error;
    }
  });

  app.get("/internal/economy/top", async (request, reply) => {
    try {
      const result = await getTopRicos(10);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof EconomyServiceError) {
        return reply.status(error.statusCode).send({
          error: error.errorCode,
          message: error.message
        });
      }

      throw error;
    }
  });
}
