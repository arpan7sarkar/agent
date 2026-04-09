import { Router, type Response } from "express";
import { z } from "zod";
import { withBindings } from "../../config/logger.js";
import { resetAgentSession } from "../../openai/runner.js";

type ApiContext = {
  correlationId: string;
  requestId: string;
  userId?: string;
};

type AuthenticatedApiContext = {
  correlationId: string;
  requestId: string;
  userId: string;
};

const sessionResetSchema = z.object({
  conversationId: z.string().uuid(),
});

function getContext(res: Response): AuthenticatedApiContext {
  const context = res.locals.apiContext as ApiContext | undefined;
  if (!context || !context.userId) {
    throw new Error("Authenticated API context is missing.");
  }
  return {
    correlationId: context.correlationId,
    requestId: context.requestId,
    userId: context.userId,
  };
}

export function registerSessionRoutes(app: Router): void {
  const router = Router();

  router.post("/session/reset", async (req, res, next) => {
    try {
      const context = getContext(res);
      const parsed = sessionResetSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid session reset payload.",
            details: parsed.error.flatten(),
          },
          correlationId: context.correlationId,
        });
        return;
      }

      const result = await resetAgentSession(context.userId, parsed.data.conversationId);
      const log = withBindings({
        correlationId: context.correlationId,
        requestId: context.requestId,
      });
      log.info(
        { conversationId: parsed.data.conversationId, sessionId: result.sessionId },
        "POST /session/reset completed",
      );

      res.json({
        ok: true,
        correlationId: context.correlationId,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(router);
}
