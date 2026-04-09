import { Router, type Response } from "express";
import { z } from "zod";
import { runApprovalFromApi } from "../../agents/approval-agent.js";
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

const approvalRespondSchema = z.object({
  approvalRequestId: z.string().uuid(),
  decision: z.enum(["approve", "reject", "approved", "rejected"]),
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

function normalizeDecision(value: "approve" | "reject" | "approved" | "rejected"): "approved" | "rejected" {
  return value === "approve" || value === "approved" ? "approved" : "rejected";
}

export function registerApprovalsRoutes(app: Router): void {
  const router = Router();

  router.post("/approval/respond", async (req, res, next) => {
    try {
      const context = getContext(res);
      const parsed = approvalRespondSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid approval response payload.",
            details: parsed.error.flatten(),
          },
          correlationId: context.correlationId,
        });
        return;
      }

      const result = await runApprovalFromApi({
        userId: context.userId,
        operation: "respond",
        approvalRequestId: parsed.data.approvalRequestId,
        decision: normalizeDecision(parsed.data.decision),
        correlationId: context.correlationId,
      });

      const log = withBindings({
        correlationId: context.correlationId,
        requestId: context.requestId,
      });
      log.info(
        {
          approvalRequestId: parsed.data.approvalRequestId,
          decision: normalizeDecision(parsed.data.decision),
        },
        "POST /approval/respond completed",
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
