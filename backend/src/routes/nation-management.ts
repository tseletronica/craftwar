import { FastifyInstance } from "fastify";

import {
  chooseNation,
  chooseNationPayloadSchema,
  demoteMemberPayloadSchema,
  demoteNationMember,
  expelMemberPayloadSchema,
  expelNationMember,
  NationManagementError,
  promoteMemberPayloadSchema,
  promoteNationMember
} from "../services/nation-management.js";

export async function registerNationManagementRoutes(app: FastifyInstance) {
  app.post("/internal/nations/select", async (request, reply) => {
    const parsed = chooseNationPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    try {
      const result = await chooseNation(parsed.data);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof NationManagementError) {
        return reply.status(error.statusCode).send({
          error: error.errorCode,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        });
      }

      throw error;
    }
  });

  app.post("/internal/nations/promote", async (request, reply) => {
    const parsed = promoteMemberPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    try {
      const result = await promoteNationMember(parsed.data);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof NationManagementError) {
        return reply.status(error.statusCode).send({
          error: error.errorCode,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        });
      }

      throw error;
    }
  });

  app.post("/internal/nations/demote", async (request, reply) => {
    const parsed = demoteMemberPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    try {
      const result = await demoteNationMember(parsed.data);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof NationManagementError) {
        return reply.status(error.statusCode).send({
          error: error.errorCode,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        });
      }

      throw error;
    }
  });

  app.post("/internal/nations/expel", async (request, reply) => {
    const parsed = expelMemberPayloadSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_payload",
        details: parsed.error.flatten().fieldErrors
      });
    }

    try {
      const result = await expelNationMember(parsed.data);
      return reply.status(200).send(result);
    } catch (error) {
      if (error instanceof NationManagementError) {
        return reply.status(error.statusCode).send({
          error: error.errorCode,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        });
      }

      throw error;
    }
  });
}
