import { Router, type Response } from "express";
import { z } from "zod";
import { runIndexerFromApi } from "../../agents/indexer-agent.js";
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

const indexRequestSchema = z.object({
  mode: z.enum(["single", "incremental_refresh", "full_reindex"]),
  sourceTypes: z.array(z.enum(["github", "google_drive", "slack", "notion"])).optional(),
  namespace: z.string().optional(),
  items: z
    .array(
      z.object({
        sourceType: z.enum(["github", "google_drive", "slack", "notion"]),
        sourceId: z.string().min(1),
        sourceUrl: z.string().optional(),
        title: z.string().optional(),
        lastModifiedAt: z.string().optional(),
        permissions: z.record(z.string(), z.unknown()).optional(),
        civicPayload: z.record(z.string(), z.unknown()).optional(),
        contentFallback: z.string().optional(),
        namespace: z.string().optional(),
        force: z.boolean().optional(),
      }),
    )
    .optional(),
});

type IndexRequestBody = z.infer<typeof indexRequestSchema>;

function sanitizeItems(items: NonNullable<IndexRequestBody["items"]>) {
  return items.map((item) => ({
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(item.lastModifiedAt ? { lastModifiedAt: item.lastModifiedAt } : {}),
    ...(item.permissions ? { permissions: item.permissions } : {}),
    ...(item.civicPayload ? { civicPayload: item.civicPayload } : {}),
    ...(item.contentFallback ? { contentFallback: item.contentFallback } : {}),
    ...(item.namespace ? { namespace: item.namespace } : {}),
    ...(typeof item.force === "boolean" ? { force: item.force } : {}),
  }));
}

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

export function registerIndexRoutes(app: Router): void {
  const router = Router();

  router.post("/index", async (req, res, next) => {
    try {
      const context = getContext(res);
      const parsed = indexRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid index request payload.",
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

      const result = await runIndexerFromApi({
        userId: context.userId,
        mode: parsed.data.mode,
        ...(parsed.data.items ? { items: sanitizeItems(parsed.data.items) } : {}),
        ...(parsed.data.sourceTypes ? { sourceTypes: parsed.data.sourceTypes } : {}),
        ...(parsed.data.namespace ? { namespace: parsed.data.namespace } : {}),
        correlationId: context.correlationId,
      });

      log.info(
        {
          mode: result.mode,
          total: result.total,
          indexed: result.indexed,
          skipped: result.skipped,
          failed: result.failed,
        },
        "POST /index completed",
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
