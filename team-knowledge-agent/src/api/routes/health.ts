import { Router, type Response } from "express";
import { withBindings } from "../../config/logger.js";
import { query } from "../../db/postgres.js";

type ApiContext = {
  correlationId: string;
  requestId: string;
  userId?: string;
};

type HealthDbRow = {
  ok: number;
};

function getContext(res: Response): ApiContext {
  const context = res.locals.apiContext as ApiContext | undefined;
  if (!context || !context.userId) {
    throw new Error("Authenticated API context is missing.");
  }
  return context;
}

export function registerHealthRoutes(app: Router): void {
  const router = Router();

  router.get("/health", async (_req, res, next) => {
    try {
      const context = getContext(res);
      const db = await query<HealthDbRow>("SELECT 1 AS ok");
      const dbHealthy = db.rows[0]?.ok === 1;

      const log = withBindings({
        correlationId: context.correlationId,
        requestId: context.requestId,
      });
      log.info({ dbHealthy }, "GET /health completed");

      res.json({
        ok: true,
        correlationId: context.correlationId,
        data: {
          status: dbHealthy ? "healthy" : "degraded",
          dbHealthy,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(router);
}

