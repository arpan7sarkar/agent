import { Router, type Response } from "express";
import { z } from "zod";
import { runStalenessFromApi } from "../../agents/staleness-agent.js";
import { withBindings } from "../../config/logger.js";

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

const stalenessRequestSchema = z.object({
  documentIds: z.array(z.string().uuid()).optional(),
  sourceTypes: z.array(z.enum(["github", "google_drive", "slack", "notion"])).optional(),
  limit: z.number().int().positive().max(500).optional(),
  includeRewriteDraft: z.boolean().optional(),
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

export function registerStalenessRoutes(app: Router): void {
  const router = Router();

  router.post("/staleness/scan", async (req, res, next) => {
    try {
      const context = getContext(res);
      const parsed = stalenessRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid staleness scan payload.",
            details: parsed.error.flatten(),
          },
          correlationId: context.correlationId,
        });
        return;
      }

      const result = await runStalenessFromApi({
        userId: context.userId,
        ...(parsed.data.documentIds ? { documentIds: parsed.data.documentIds } : {}),
        ...(parsed.data.sourceTypes ? { sourceTypes: parsed.data.sourceTypes } : {}),
        ...(typeof parsed.data.limit === "number" ? { limit: parsed.data.limit } : {}),
        ...(typeof parsed.data.includeRewriteDraft === "boolean"
          ? { includeRewriteDraft: parsed.data.includeRewriteDraft }
          : {}),
        correlationId: context.correlationId,
      });

      const log = withBindings({
        correlationId: context.correlationId,
        requestId: context.requestId,
      });
      log.info(
        {
          total: result.total,
          fresh: result.fresh,
          possiblyStale: result.possiblyStale,
          stale: result.stale,
        },
        "POST /staleness/scan completed",
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
