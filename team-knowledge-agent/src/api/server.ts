import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { logger, newCorrelationId, withBindings } from "../config/logger.js";
import { registerApprovalsRoutes } from "./routes/approvals.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIndexRoutes } from "./routes/index.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerStalenessRoutes } from "./routes/staleness.js";

type ApiContext = {
  correlationId: string;
  requestId: string;
  userId?: string;
};

const authSchema = z.object({
  authorization: z.string().min(1),
  userId: z.string().uuid(),
});

function extractBearerToken(authorization: string): string | null {
  const [scheme, token] = authorization.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim();
}

function getApiContext(res: Response): ApiContext {
  const context = res.locals.apiContext as ApiContext | undefined;
  if (!context) {
    throw new Error("API context missing on request.");
  }
  return context;
}

function authenticationMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    const context = getApiContext(res);
    const parsed = authSchema.safeParse({
      authorization: req.headers.authorization,
      userId: req.headers["x-user-id"],
    });

    if (!parsed.success) {
      res.status(401).json({
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid authentication headers.",
        },
        correlationId: context.correlationId,
      });
      return;
    }

    const token = extractBearerToken(parsed.data.authorization);
    if (!token) {
      res.status(401).json({
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Authorization header must use Bearer token format.",
        },
        correlationId: context.correlationId,
      });
      return;
    }

    const env = getEnv();
    if (token !== env.API_AUTH_TOKEN) {
      res.status(401).json({
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid authentication token.",
        },
        correlationId: context.correlationId,
      });
      return;
    }

    context.userId = parsed.data.userId;
    next();
  } catch (error) {
    next(error);
  }
}

export function createApiServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const correlationIdHeader = req.headers["x-correlation-id"];
    const correlationId =
      typeof correlationIdHeader === "string" && correlationIdHeader.trim().length > 0
        ? correlationIdHeader.trim()
        : newCorrelationId();

    const requestId = newCorrelationId();
    res.locals.apiContext = { correlationId, requestId } satisfies ApiContext;
    res.setHeader("x-correlation-id", correlationId);

    const log = withBindings({ correlationId, requestId });
    const startedAt = Date.now();
    log.info(
      { method: req.method, path: req.path, ip: req.ip ?? "unknown" },
      "HTTP request started",
    );

    res.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      log.info(
        { method: req.method, path: req.path, statusCode: res.statusCode, durationMs },
        "HTTP request completed",
      );
    });

    next();
  });

  app.use(authenticationMiddleware);

  registerChatRoutes(app);
  registerIndexRoutes(app);
  registerStalenessRoutes(app);
  registerApprovalsRoutes(app);
  registerSessionRoutes(app);
  registerHealthRoutes(app);

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const context = getApiContext(res);
    const log = withBindings({
      correlationId: context.correlationId,
      requestId: context.requestId,
    });
    log.error(
      {
        err: error,
        method: req.method,
        path: req.path,
        userId: context.userId ?? null,
      },
      "Unhandled API error",
    );

    res.status(500).json({
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected API error.",
      },
      correlationId: context.correlationId,
    });
  });

  return app;
}

export async function startApiServer(): Promise<{ app: ReturnType<typeof createApiServer>; server: Server }> {
  const env = getEnv();
  const app = createApiServer();
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(env.PORT, () => resolve(instance));
  });

  logger.info({ port: env.PORT }, "HTTP API server started");
  return { app, server };
}

