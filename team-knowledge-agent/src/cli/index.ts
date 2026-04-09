import { newCorrelationId, withBindings } from "../config/logger.js";

type ParsedArgs = {
  command: string | null;
  options: Record<string, string>;
  flags: Set<string>;
  positionals: string[];
};

const SOURCE_TYPES = new Set(["github", "google_drive", "slack", "notion"]);
const INDEX_MODES = new Set(["single", "incremental_refresh", "full_reindex"]);
const DECISION_MAP: Record<string, "approved" | "rejected"> = {
  approve: "approved",
  approved: "approved",
  reject: "rejected",
  rejected: "rejected",
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token) continue;

    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (!key) continue;
      const next = rest[i + 1];
      if (!next || next.startsWith("--")) {
        flags.add(key);
        continue;
      }
      options[key] = next;
      i += 1;
      continue;
    }

    positionals.push(token);
  }

  return {
    command: command ?? null,
    options,
    flags,
    positionals,
  };
}

function requireOption(args: ParsedArgs, key: string, message?: string): string {
  const value = args.options[key];
  if (!value || value.trim().length === 0) {
    throw new Error(message ?? `Missing required option --${key}.`);
  }
  return value.trim();
}

function optionalCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function asSourceTypes(values: string[] | undefined): Array<"github" | "google_drive" | "slack" | "notion"> | undefined {
  if (!values || values.length === 0) return undefined;
  const parsed: Array<"github" | "google_drive" | "slack" | "notion"> = [];
  for (const value of values) {
    if (!SOURCE_TYPES.has(value)) {
      throw new Error(`Invalid source type: ${value}.`);
    }
    parsed.push(value as "github" | "google_drive" | "slack" | "notion");
  }
  return parsed;
}

function parsePositiveInt(value: string | undefined, keyName: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${keyName} must be a positive integer.`);
  }
  return parsed;
}

function printUsage(): void {
  const text = `
Usage:
  agent ask --user-id <uuid> --conversation-id <uuid> --message "<text>"
  agent index --user-id <uuid> --mode <single|incremental_refresh|full_reindex> [options]
  agent scan-stale --user-id <uuid> [options]
  agent approve --user-id <uuid> [--list | --id <approval-id> --decision <approve|reject>]
  agent reset-session --user-id <uuid> --conversation-id <uuid>

Index options:
  --source-type <github|google_drive|slack|notion>   (single mode)
  --source-id <id>                                    (single mode)
  --source-url <url>                                  (single mode, optional)
  --namespace <name>                                  (optional)
  --source-types <csv>                                (incremental/full mode filter)
  --force                                             (single mode optional)
  --items-json '<json array>'                         (advanced override)

Staleness options:
  --document-ids <csv uuid>
  --source-types <csv>
  --limit <number>
  --include-rewrite-draft

Approval options:
  --list
  --id <approval-request-id> --decision <approve|reject>
`;
  process.stdout.write(text.trimStart());
  process.stdout.write("\n");
}

async function runAsk(args: ParsedArgs, correlationId: string): Promise<unknown> {
  const { runAgent } = await import("../openai/runner.js");
  const userId = requireOption(args, "user-id");
  const conversationId = requireOption(args, "conversation-id");
  const message = args.options.message ?? args.positionals.join(" ");
  if (!message || message.trim().length === 0) {
    throw new Error("Missing required message. Provide --message or positional text.");
  }

  return runAgent({
    userId,
    conversationId,
    message: message.trim(),
    correlationId,
    requestId: newCorrelationId(),
  });
}

async function runIndex(args: ParsedArgs, correlationId: string): Promise<unknown> {
  const { runIndexerFromCli } = await import("../agents/indexer-agent.js");
  const userId = requireOption(args, "user-id");
  const mode = requireOption(args, "mode");
  if (!INDEX_MODES.has(mode)) {
    throw new Error(`Invalid mode: ${mode}. Expected one of single|incremental_refresh|full_reindex.`);
  }

  const namespace = args.options.namespace?.trim();
  const sourceTypes = asSourceTypes(optionalCsv(args.options["source-types"]));
  const itemsJson = args.options["items-json"];

  if (itemsJson) {
    const parsed = JSON.parse(itemsJson);
    if (!Array.isArray(parsed)) {
      throw new Error("--items-json must be a JSON array.");
    }
    return runIndexerFromCli({
      userId,
      mode: mode as "single" | "incremental_refresh" | "full_reindex",
      items: parsed,
      ...(sourceTypes ? { sourceTypes } : {}),
      ...(namespace ? { namespace } : {}),
      correlationId,
    });
  }

  if (mode === "single") {
    const sourceType = requireOption(args, "source-type");
    const sourceId = requireOption(args, "source-id");
    if (!SOURCE_TYPES.has(sourceType)) {
      throw new Error(`Invalid --source-type value: ${sourceType}.`);
    }

    return runIndexerFromCli({
      userId,
      mode: "single",
      items: [
        {
          sourceType: sourceType as "github" | "google_drive" | "slack" | "notion",
          sourceId,
          ...(args.options["source-url"] ? { sourceUrl: args.options["source-url"] } : {}),
          ...(args.flags.has("force") ? { force: true } : {}),
        },
      ],
      ...(namespace ? { namespace } : {}),
      correlationId,
    });
  }

  return runIndexerFromCli({
    userId,
    mode: mode as "incremental_refresh" | "full_reindex",
    ...(sourceTypes ? { sourceTypes } : {}),
    ...(namespace ? { namespace } : {}),
    correlationId,
  });
}

async function runScanStale(args: ParsedArgs, correlationId: string): Promise<unknown> {
  const { runStalenessFromCli } = await import("../agents/staleness-agent.js");
  const userId = requireOption(args, "user-id");
  const documentIds = optionalCsv(args.options["document-ids"]);
  const sourceTypes = asSourceTypes(optionalCsv(args.options["source-types"]));
  const limit = parsePositiveInt(args.options.limit, "limit");

  return runStalenessFromCli({
    userId,
    ...(documentIds ? { documentIds } : {}),
    ...(sourceTypes ? { sourceTypes } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(args.flags.has("include-rewrite-draft") ? { includeRewriteDraft: true } : {}),
    correlationId,
  });
}

async function runApprove(args: ParsedArgs, correlationId: string): Promise<unknown> {
  const { runApprovalFromCli } = await import("../agents/approval-agent.js");
  const userId = requireOption(args, "user-id");

  if (args.flags.has("list")) {
    const limit = parsePositiveInt(args.options.limit, "limit");
    return runApprovalFromCli({
      userId,
      operation: "list",
      ...(typeof limit === "number" ? { limit } : {}),
      correlationId,
    });
  }

  const approvalRequestId = args.options.id;
  const decisionRaw = args.options.decision;
  if (approvalRequestId && decisionRaw) {
    const decision = DECISION_MAP[decisionRaw.trim().toLowerCase()];
    if (!decision) {
      throw new Error("Invalid --decision value. Use approve or reject.");
    }
    return runApprovalFromCli({
      userId,
      operation: "respond",
      approvalRequestId: approvalRequestId.trim(),
      decision,
      correlationId,
    });
  }

  throw new Error("agent approve requires --list OR --id <approval-id> --decision <approve|reject>.");
}

async function runResetSession(args: ParsedArgs): Promise<unknown> {
  const { resetAgentSession } = await import("../openai/runner.js");
  const userId = requireOption(args, "user-id");
  const conversationId = requireOption(args, "conversation-id");
  return resetAgentSession(userId, conversationId);
}

let shouldClosePostgres = false;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "help" || args.flags.has("help")) {
    printUsage();
    return;
  }

  const correlationId = args.options["correlation-id"]?.trim() || newCorrelationId();
  const requestId = newCorrelationId();
  const log = withBindings({ correlationId, requestId });
  shouldClosePostgres = true;

  let result: unknown;
  switch (args.command) {
    case "ask":
      result = await runAsk(args, correlationId);
      break;
    case "index":
      result = await runIndex(args, correlationId);
      break;
    case "scan-stale":
      result = await runScanStale(args, correlationId);
      break;
    case "approve":
      result = await runApprove(args, correlationId);
      break;
    case "reset-session":
      result = await runResetSession(args);
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }

  log.info({ command: args.command }, "CLI command completed");
  process.stdout.write(`${JSON.stringify({ ok: true, correlationId, data: result }, null, 2)}\n`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!shouldClosePostgres) return;
    const { closePostgres } = await import("../db/postgres.js");
    await closePostgres();
  });
