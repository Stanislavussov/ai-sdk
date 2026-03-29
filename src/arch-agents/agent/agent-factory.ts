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
import { log } from "../logger.js";
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

// ── Manifest parsing ───────────────────────────────────────

function parseManifest(agent: string, raw: string): AgentManifest {
  const parsed = JSON.parse(raw) as {
    changedFiles?: unknown;
    summary?: unknown;
    exports?: unknown;
  };

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
  siblings?: AgentDefinition[],
): Promise<AgentManifest> {
  const cwd = config.cwd ? path.resolve(config.cwd) : process.cwd();
  const manifestDir = config.manifestDir
    ? path.resolve(config.manifestDir)
    : os.tmpdir();

  log.info("AGENT", `═══ runAgent("${def.name}") ═══`, {
    role: def.role,
    type: def.type ?? "coding",
    model: def.model ?? config.model,
    thinkingLevel: def.thinkingLevel ?? config.thinkingLevel ?? "default",
    cwd,
    manifestDir,
    skills: def.skills ?? [],
    enabledTools: def.enabledTools ?? "(from type)",
    siblings: siblings?.map((s) => s.name) ?? [],
    dependencyContextLength: dependencyContext.length,
  });

  fs.mkdirSync(manifestDir, { recursive: true });

  const manifestPath = path.join(
    manifestDir,
    `${def.name}-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  log.debug("AGENT", `Manifest file path: ${manifestPath}`);

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const model = resolveModel(def.model ?? config.model, modelRegistry);

  log.debug("AGENT", `Model resolved: ${def.model ?? config.model}`);

  const agentSkills = buildAgentSkills(def.skills, cwd);
  if (agentSkills.length > 0) {
    log.debug("AGENT", `Loaded ${agentSkills.length} skills`, {
      skills: agentSkills.map((s) => s.name),
    });
  }

  const systemPrompt = buildAgentSystemPrompt(def, dependencyContext, siblings);
  log.debug("AGENT", `System prompt built (${systemPrompt.length} chars)`);

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
  log.debug("AGENT", `Tools resolved for "${def.name}"`, {
    tools: builtinTools.map((t) => t.name),
  });

  // Check if agent has write tool — needed for manifest file protocol
  const hasWriteTool = builtinTools.some((tool) =>
    tool.name === "write" || tool.name === "Write"
  );
  const skipManifestFile = !hasWriteTool;
  log.debug("AGENT", `Manifest protocol: ${skipManifestFile ? "SKIP (read-only)" : "FILE-BASED"}`, {
    hasWriteTool,
  });

  log.info("AGENT", `Creating session for "${def.name}"...`);

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
      const prompt = buildReadOnlyTaskPrompt(task);
      log.info("AGENT", `Sending read-only prompt to "${def.name}" (${prompt.length} chars)`);
      log.debug("AGENT", `Prompt preview: ${prompt.slice(0, 300)}...`);
      await session.prompt(prompt);
    } else {
      const prompt = buildOrchestratorTaskPrompt(task, manifestPath);
      log.info("AGENT", `Sending task prompt to "${def.name}" (${prompt.length} chars)`, {
        manifestPath,
      });
      log.debug("AGENT", `Prompt preview: ${prompt.slice(0, 300)}...`);
      await session.prompt(prompt);
    }
    log.info("AGENT", `Session for "${def.name}" completed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("AGENT", `Session for "${def.name}" failed: ${msg}`);
    throw err;
  } finally {
    unsubCapture?.();
    unsubActivity?.();
    session.dispose();
  }

  if (skipManifestFile) {
    // Read-only agent: build manifest from captured output (no file write needed)
    log.info("AGENT", `"${def.name}" read-only output (${lastAssistantText.length} chars)`);
    return {
      agent: def.name,
      changedFiles: [],
      summary: lastAssistantText.trim() || "(no output)",
      exports: {},
    };
  }

  if (!fs.existsSync(manifestPath)) {
    // Agent had nothing to do — return a no-op manifest instead of failing the wave
    log.warn("AGENT", `"${def.name}" did NOT write manifest file — returning no-op manifest`, {
      expectedPath: manifestPath,
    });
    return {
      agent: def.name,
      changedFiles: [],
      summary: "(no changes needed)",
      exports: {},
    };
  }

  const manifestRaw = fs.readFileSync(manifestPath, "utf8");
  fs.unlinkSync(manifestPath);

  log.info("AGENT", `"${def.name}" manifest parsed`, {
    rawLength: manifestRaw.length,
    preview: manifestRaw.slice(0, 200),
  });

  return parseManifest(def.name, manifestRaw);
}
