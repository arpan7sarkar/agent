import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),

    OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
    OPENAI_MODEL: z.string().min(1).default("gpt-5.2"),
    OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-large"),

    CIVIC_TOKEN: z.string().min(1, "CIVIC_TOKEN is required"),
    CIVIC_PROFILE_ID: z.string().min(1, "CIVIC_PROFILE_ID is required"),
    CIVIC_BASE_URL: z.string().default("https://app.civic.com/hub/mcp"),
    CIVIC_LOCK_PROFILE: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value !== "false"),
    CIVIC_SLACK_WRITE_CHANNEL: z.string().optional(),
    CIVIC_NOTION_WRITE_PAGE_IDS: z.string().optional(),
    CIVIC_JIRA_PROJECT_KEYS: z.string().optional(),
    CIVIC_GMAIL_LABEL_IDS: z.string().optional(),

    PINECONE_API_KEY: z.string().min(1, "PINECONE_API_KEY is required"),
    PINECONE_INDEX: z.string().min(1, "PINECONE_INDEX is required"),
    PINECONE_NAMESPACE: z.string().optional(),

    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.string().optional(),
    API_AUTH_TOKEN: z.string().min(1, "API_AUTH_TOKEN is required"),
  })
  .passthrough();

export type AppEnv = z.infer<typeof envSchema>;

let cachedEnv: AppEnv | null = null;

function formatZodError(err: z.ZodError): string {
  // Keep this message actionable: list keys and why.
  const lines = err.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    return `- ${key}: ${issue.message}`;
  });
  return lines.join("\n");
}

export function getEnv(): AppEnv {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = formatZodError(parsed.error);
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}
