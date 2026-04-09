export type CivicToolSource =
  | "github"
  | "google_drive"
  | "slack"
  | "notion"
  | "jira"
  | "gmail";
export type CivicToolMode = "read" | "write";

export type CivicToolDefinition = {
  name: string;
  source: CivicToolSource;
  mode: CivicToolMode;
  description: string;
  requiresApproval: boolean;
  allowedSlackChannelId?: string;
  allowedNotionPageIds?: string[];
};

export type CivicToolRegistry = Map<string, CivicToolDefinition>;

export type CivicToolRegistryOptions = {
  slackWriteChannelId?: string;
  notionWritePageIds?: string[];
  jiraProjectKeys?: string[];
  gmailLabelIds?: string[];
};

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function parseCsvList(value?: string): string[] {
  if (!value) return [];
  return uniqueNonEmpty(value.split(","));
}

export function buildCivicToolRegistry(
  options: CivicToolRegistryOptions = {},
): CivicToolRegistry {
  const registry = new Map<string, CivicToolDefinition>();

  const readOnlyTools: CivicToolDefinition[] = [
    {
      name: "github.search_code",
      source: "github",
      mode: "read",
      description: "Search GitHub code and metadata for indexing and retrieval.",
      requiresApproval: false,
    },
    {
      name: "github.get_file",
      source: "github",
      mode: "read",
      description: "Read repository file contents for knowledge ingestion.",
      requiresApproval: false,
    },
    {
      name: "drive.list_files",
      source: "google_drive",
      mode: "read",
      description: "List Google Drive files from approved folders.",
      requiresApproval: false,
    },
    {
      name: "drive.get_file_content",
      source: "google_drive",
      mode: "read",
      description: "Read Google Drive file content for indexing.",
      requiresApproval: false,
    },
    {
      name: "slack.search_messages",
      source: "slack",
      mode: "read",
      description: "Search Slack messages for operational context.",
      requiresApproval: false,
    },
    {
      name: "slack.get_channel_history",
      source: "slack",
      mode: "read",
      description: "Read channel message history for context retrieval.",
      requiresApproval: false,
    },
    {
      name: "notion.search",
      source: "notion",
      mode: "read",
      description: "Search Notion pages and databases for relevant docs.",
      requiresApproval: false,
    },
    {
      name: "notion.get_page",
      source: "notion",
      mode: "read",
      description: "Read Notion page contents for QA and indexing.",
      requiresApproval: false,
    },
    {
      name: "jira.search_issues",
      source: "jira",
      mode: "read",
      description: "Search Jira issues and metadata for team knowledge retrieval.",
      requiresApproval: false,
    },
    {
      name: "jira.get_issue",
      source: "jira",
      mode: "read",
      description: "Read Jira issue details for grounding and status checks.",
      requiresApproval: false,
    },
    {
      name: "gmail.search_threads",
      source: "gmail",
      mode: "read",
      description: "Search Gmail threads for historical communication context.",
      requiresApproval: false,
    },
    {
      name: "gmail.get_thread",
      source: "gmail",
      mode: "read",
      description: "Read Gmail thread content for retrieval and QA.",
      requiresApproval: false,
    },
  ];

  const writeTools: CivicToolDefinition[] = [
    {
      name: "slack.post_message",
      source: "slack",
      mode: "write",
      description: "Post a Slack message only to the explicitly allowed bot channel.",
      requiresApproval: true,
      ...(options.slackWriteChannelId
        ? { allowedSlackChannelId: options.slackWriteChannelId }
        : {}),
    },
    {
      name: "notion.update_page",
      source: "notion",
      mode: "write",
      description: "Update Notion pages only via the approved write path.",
      requiresApproval: true,
      ...(options.notionWritePageIds && options.notionWritePageIds.length > 0
        ? { allowedNotionPageIds: uniqueNonEmpty(options.notionWritePageIds) }
        : {}),
    },
  ];

  for (const tool of [...readOnlyTools, ...writeTools]) {
    registry.set(tool.name, tool);
  }

  return registry;
}

export function getRegisteredTool(
  registry: CivicToolRegistry,
  toolName: string,
): CivicToolDefinition | null {
  return registry.get(toolName) ?? null;
}

export function listRegisteredTools(registry: CivicToolRegistry): CivicToolDefinition[] {
  return [...registry.values()];
}
