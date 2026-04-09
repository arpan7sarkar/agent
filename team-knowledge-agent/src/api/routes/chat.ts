import { Router, type Response } from "express";
import { z } from "zod";
import { withBindings } from "../../config/logger.js";
import { runAgent } from "../../openai/runner.js";

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

const chatRequestSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().min(1),
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

export function registerChatRoutes(app: Router): void {
  const router = Router();

  router.post("/chat", async (req, res, next) => {
    try {
      const context = getContext(res);
      const parsed = chatRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid chat request payload.",
            details: parsed.error.flatten(),
          },
          correlationId: context.correlationId,
        });
        return;
      }

      const log = withBindings({
        correlationId: context.correlationId,
        requestId: context.requestId,
      });

      const result = await runAgent({
        userId: context.userId,
        conversationId: parsed.data.conversationId,
        message: parsed.data.message,
        correlationId: context.correlationId,
        requestId: context.requestId,
      });

      log.info(
        { route: result.route, sessionId: result.sessionId, traceId: result.traceId },
        "POST /chat completed",
      );

      res.json({
        ok: true,
        correlationId: context.correlationId,
        data: {
          route: result.route,
          response: result.response,
          sessionId: result.sessionId,
          traceId: result.traceId,
          specialistOutput: result.specialistOutput,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(router);
}
