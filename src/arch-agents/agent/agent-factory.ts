import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createCodingTools,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import type { AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import { resolveModel } from "../model/model-resolver.js";
import { buildAgentSystemPrompt, buildOrchestratorTaskPrompt, buildReadOnlyTaskPrompt } from "../prompts/prompts.js";
import { AGENT_TYPES, TOOL_NAMES } from "../constants.js";
import type { AgentDefinition, AgentManifest, AgentType, OrchestratorConfig } from "../types.js";

// ── Tool resolution ────────────────────────────────────────

type Tool = AgentTool<any>;

const TOOL_FACTORIES: Record<string, (cwd: string) => Tool> = {
  read:  (cwd) => createReadTool(cwd),
  bash:  (cwd) => createBashTool(cwd),
  edit:  (cwd) => createEditTool(cwd),
  write: (cwd) => createWriteTool(cwd),
  grep:  (cwd) => createGrepTool(cwd),
  find:  (cwd) => createFindTool(cwd),
  ls:    (cwd) => createLsTool(cwd),
};

const VALID_TOOL_NAMES = TOOL_NAMES.join(", ");

function resolveBuiltinTools(def: AgentDefinition, cwd: string): Tool[] {
  // enabledTools takes priority — cherry-pick individual tools
  if (def.enabledTools && def.enabledTools.length > 0) {
    return def.enabledTools.map((name) => {
      const factory = TOOL_FACTORIES[name];
      if (!factory) {
        throw new Error(
          `Agent "${def.name}": unknown tool "${name}" in enabledTools. Valid: ${VALID_TOOL_NAMES}`,
        );
      }
      return factory(cwd);
    });
  }

  // Fall back to type presets
  const agentType: AgentType = def.type ?? "coding";

  switch (agentType) {
    case "coding":
      return createCodingTools(cwd);
    case "readonly":
      return createReadOnlyTools(cwd);
    case "all":
      return Object.values(TOOL_FACTORIES).map((f) => f(cwd));
    case "none":
      return [];
    default: {
      throw new Error(
        `Agent "${def.name}": unknown type "${agentType}". Valid: ${AGENT_TYPES.join(", ")}`,
      );
    }
  }
}

// ── Skills ─────────────────────────────────────────────────

function buildAgentSkills(skillDirs: string[] | undefined, cwd: string): Skill[] {
  const dirs = skillDirs ?? [];

  return dirs.map((dir) => {
    const baseDir = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);

    return {
      name: path.basename(baseDir),
      description: `Skill for the ${path.basename(baseDir)} layer agent.`,
      filePath: path.join(baseDir, "SKILL.md"),
      baseDir,
      path: baseDir,
      source: "custom" as const,
    } as unknown as Skill;
  });
}

// ── Manifest JSON repair ──────────────────────────────────

/**
 * Attempt to extract valid JSON from raw LLM output.
 *
 * LLMs commonly produce:
 * - JSON wrapped in markdown code fences (```json ... ```)
 * - Trailing commas before `}` or `]`
 * - Leading/trailing prose around the JSON object
 *
 * This function handles all of these before handing off to JSON.parse.
 */
export function repairManifestJson(raw: string): string {
  let text = raw.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // If the text doesn't start with `{`, try to find the first `{` ... last `}`
  if (!text.startsWith("{")) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
  }

  // Remove trailing commas before } or ]
  text = text.replace(/,\s*([}\]])/g, "$1");

  return text;
}

// ── Manifest parsing ───────────────────────────────────────

function parseManifest(agent: string, raw: string): AgentManifest {
  const repaired = repairManifestJson(raw);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(repaired);
  } catch {
    throw new Error(
      `Invalid manifest JSON for agent "${agent}": could not parse after repair. Raw content (first 200 chars): ${raw.slice(0, 200)}`,
    );
  }

  // ── Lenient field recovery ──────────────────────────────
  // Missing changedFiles → default to []
  if (parsed.changedFiles === undefined || parsed.changedFiles === null) {
    parsed.changedFiles = [];
  }
  // Missing summary → default to "(no summary)"
  if (parsed.summary === undefined || parsed.summary === null) {
    parsed.summary = "(no summary)";
  }
  // Missing exports → default to {}
  if (parsed.exports === undefined || parsed.exports === null) {
    parsed.exports = {};
  }

  if (!Array.isArray(parsed.changedFiles) || !parsed.changedFiles.every((v) => typeof v === "string")) {
    throw new Error(`Invalid manifest for agent "${agent}": changedFiles must be string[]`);
  }

  if (typeof parsed.summary !== "string") {
    throw new Error(`Invalid manifest for agent "${agent}": summary must be string`);
  }

  if (typeof parsed.exports !== "object" || parsed.exports === null || Array.isArray(parsed.exports)) {
    throw new Error(`Invalid manifest for agent "${agent}": exports must be Record<string, string>`);
  }

  const exportsRecord = Object.entries(parsed.exports).reduce<Record<string, string>>((acc, [key, value]) => {
    if (typeof value !== "string") {
      throw new Error(`Invalid manifest for agent "${agent}": exports.${key} must be string`);
    }
    acc[key] = value;
    return acc;
  }, {});

  return {
    agent,
    changedFiles: parsed.changedFiles,
    summary: parsed.summary,
    exports: exportsRecord,
  };
}

// ── Activity description ───────────────────────────────────

/**
 * Turn a raw AgentEvent into a short, informal status string.
 * Returns `undefined` for events that don't warrant a visible update.
 */
function describeActivity(event: AgentEvent): string | undefined {
  switch (event.type) {
    case "message_start":
      return "🧠 Thinking…";

    case "tool_execution_start": {
      const args = event.args ?? {};
      switch (event.toolName) {
        case "Read":
        case "read":
          return args.path ? `📖 Reading ${args.path}` : "📖 Reading a file";
        case "Bash":
        case "bash":
          return args.command
            ? `⚡ Running: ${String(args.command).slice(0, 120)}`
            : "⚡ Running a command";
        case "Edit":
        case "edit":
          return args.path ? `✏️ Editing ${args.path}` : "✏️ Editing a file";
        case "Write":
        case "write":
          return args.path ? `📝 Writing ${args.path}` : "📝 Writing a file";
        case "Grep":
        case "grep":
          return args.pattern
            ? `🔍 Searching for "${args.pattern}"`
            : "🔍 Searching files";
        case "Find":
        case "find":
          return args.pattern
            ? `🔎 Finding files matching "${args.pattern}"`
            : "🔎 Finding files";
        case "Ls":
        case "ls":
          return args.path ? `📂 Listing ${args.path}` : "📂 Listing directory";
        default:
          return `🔧 Using tool: ${event.toolName}`;
      }
    }

    case "tool_execution_end":
      return event.isError
        ? `❌ Tool ${event.toolName} failed`
        : undefined;

    default:
      return undefined;
  }
}

// ── Agent runner ───────────────────────────────────────────

export async function runAgent(
  def: AgentDefinition,
  task: string,
  dependencyContext: string,
  config: OrchestratorConfig,
): Promise<AgentManifest> {
  const cwd = config.cwd ? path.resolve(config.cwd) : process.cwd();
  const manifestDir = config.manifestDir
    ? path.resolve(config.manifestDir)
    : os.tmpdir();

  fs.mkdirSync(manifestDir, { recursive: true });

  const manifestPath = path.join(
    manifestDir,
    `${def.name}-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const model = resolveModel(def.model ?? config.model, modelRegistry);

  const agentSkills = buildAgentSkills(def.skills, cwd);
  const systemPrompt = buildAgentSystemPrompt(def, dependencyContext);

  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => systemPrompt,
    skillsOverride: (current) => ({
      skills: [...current.skills, ...agentSkills],
      diagnostics: current.diagnostics,
    }),
  });

  await loader.reload();

  // Resolve built-in tools based on type / enabledTools
  const builtinTools = resolveBuiltinTools(def, cwd);

  // Check if agent has write tool — needed for manifest file protocol
  const hasWriteTool = builtinTools.some((tool) =>
    tool.name === "write" || tool.name === "Write"
  );
  const skipManifestFile = !hasWriteTool;

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    cwd,
    model,
    thinkingLevel: def.thinkingLevel ?? config.thinkingLevel,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    tools: builtinTools,
    customTools: (def.tools ?? []) as AgentTool<any>[],
  });

  // Forward real-time activity to onProgress as informal status messages
  let unsubActivity: (() => void) | undefined;
  if (config.onProgress) {
    unsubActivity = session.subscribe((event) => {
      const message = describeActivity(event as AgentEvent);
      if (message) {
        config.onProgress!({ type: "agent_activity", agent: def.name, message });
      }
    });
  }

  // Capture last assistant text for read-only agents that skip manifest files
  let lastAssistantText = "";
  let unsubCapture: (() => void) | undefined;
  if (skipManifestFile) {
    unsubCapture = session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        lastAssistantText += event.assistantMessageEvent.delta;
      }
    });
  }

  try {
    if (skipManifestFile) {
      await session.prompt(buildReadOnlyTaskPrompt(task));
    } else {
      await session.prompt(buildOrchestratorTaskPrompt(task, manifestPath));
    }
  } finally {
    unsubCapture?.();
    unsubActivity?.();
    session.dispose();
  }

  if (skipManifestFile) {
    // Read-only agent: build manifest from captured output (no file write needed)
    return {
      agent: def.name,
      changedFiles: [],
      summary: lastAssistantText.trim() || "(no output)",
      exports: {},
    };
  }

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Agent "${def.name}" did not write manifest file: ${manifestPath}`);
  }

  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  fs.unlinkSync(manifestPath);

  return parseManifest(def.name, manifestRaw);
}
