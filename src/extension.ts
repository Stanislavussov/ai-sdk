import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TObject, type TOptional, type TArray } from "@sinclair/typebox";
import { createOrchestrator } from "./arch-agents/index.js";
import { runAgent } from "./arch-agents/agent/agent-factory.js";
import type { AgentDefinition, AgentManifest, AgentType, OrchestratorConfig, ProgressEvent } from "./arch-agents/types.js";

// ── Inline agent definition schema (recursive for subAgents) ──

function buildAgentDefinitionSchema(): TObject {
  // TypeBox doesn't support recursive refs easily, so we use a two-level
  // inline definition (subAgents → subAgents) which covers practical usage.
  const subAgentProps = {
    name: Type.String({ description: "Unique agent identifier" }),
    role: Type.String({ description: "What this agent is responsible for" }),
    rules: Type.String({ description: "Constraints and style rules" }),
    dependsOn: Type.Optional(
      Type.Array(Type.String(), { description: "Agent names this agent depends on (sibling sub-agents)" }),
    ),
    model: Type.Optional(Type.String({ description: "Model override for this agent" })),
    type: Type.Optional(
      Type.String({
        description:
          'Agent type: "coding" (read/bash/edit/write), "readonly" (read/grep/find/ls), "all" (every tool), "none" (no built-in tools). Default: "coding"',
      }),
    ),
    enabledTools: Type.Optional(
      Type.Array(Type.String(), {
        description: "Cherry-pick specific tools: read, bash, edit, write, grep, find, ls. Overrides type.",
      }),
    ),
    skills: Type.Optional(
      Type.Array(Type.String(), { description: "Skill directory paths" }),
    ),
    standalone: Type.Optional(
      Type.Boolean({
        description: "When true, exclude this agent from the orchestration pipeline.",
      }),
    ),
  };

  // Level 2 sub-agent (deepest inline level — no further subAgents in tool params)
  const level2 = Type.Object(subAgentProps);

  // Level 1 sub-agent (can have subAgents at level 2)
  const level1 = Type.Object({
    ...subAgentProps,
    subAgents: Type.Optional(
      Type.Array(level2, {
        description: "Nested sub-agents (one more level of nesting).",
      }),
    ),
  });

  // Top-level agent definition (can have subAgents at level 1)
  return Type.Object({
    ...subAgentProps,
    subAgents: Type.Optional(
      Type.Array(level1, {
        description:
          "Nested sub-agents forming a mini-pipeline under this agent. " +
          "Sub-agents run in waves, inherit model/thinkingLevel from parent, " +
          "and their manifests merge into the parent's manifest.",
      }),
    ),
  });
}

const AgentDefinitionSchema = buildAgentDefinitionSchema();

// ── Config schema ──────────────────────────────────────────
// Loaded from .pi/settings.json → "orchestrator" key

interface OrchestratorFileConfig {
  model: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  manifestDir?: string;
  agents: AgentDefinitionConfig[];
}

interface AgentDefinitionConfig {
  name: string;
  role: string;
  rules: string;
  dependsOn?: string[];
  model?: string;
  type?: AgentType;
  enabledTools?: string[];
  skills?: string[];
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  standalone?: boolean;
  subAgents?: AgentDefinitionConfig[];
}

// ── Config loading ─────────────────────────────────────────

function loadConfig(cwd: string): OrchestratorFileConfig | null {
  // Primary: .pi/settings.json → "orchestrator" key
  const settingsPath = path.resolve(cwd, ".pi/settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (raw.orchestrator && Array.isArray(raw.orchestrator.agents)) {
        if (!raw.orchestrator.model || typeof raw.orchestrator.model !== "string") {
          throw new Error(
            'orchestrator.model is required in .pi/settings.json. ' +
            'Specify a default model, e.g. "anthropic/claude-sonnet-4-5".',
          );
        }
        return raw.orchestrator as OrchestratorFileConfig;
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        // ignore JSON parse errors
      } else {
        throw err;
      }
    }
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────

function formatManifests(manifests: AgentManifest[]): string {
  return manifests
    .map((m) => {
      const exports = Object.entries(m.exports)
        .map(([sym, loc]) => `    ${sym} → ${loc}`)
        .join("\n");
      return [
        `[${m.agent}]`,
        `  Summary: ${m.summary}`,
        `  Files:   ${m.changedFiles.join(", ")}`,
        exports ? `  Exports:\n${exports}` : "  Exports: (none)",
      ].join("\n");
    })
    .join("\n\n");
}

function buildProgressHandler(onUpdate?: (result: any) => void) {
  const lines: string[] = [];

  const onProgress = (event: ProgressEvent): void => {
    switch (event.type) {
      case "wave_start":
        lines.push(`→ Wave ${event.wave}: [${event.agents.join(", ")}]`);
        break;
      case "agent_start":
        lines.push(`  ▶ ${event.agent} starting (${event.model})`);
        break;
      case "agent_done":
        lines.push(`  ✓ ${event.agent}: ${event.manifest.summary}`);
        break;
      case "agent_error":
        lines.push(`  ✗ ${event.agent}: ${event.error.message}`);
        break;
      case "orchestrator_done":
        lines.push(`✓ Orchestration complete — ${event.manifests.length} agents finished`);
        break;
    }
    onUpdate?.({
      content: [{ type: "text", text: lines.join("\n") }],
      details: {},
    });
  };

  return { onProgress, lines };
}

// ── Agent name collection (includes sub-agents) ───────────

function collectAgentNames(agents: AgentDefinitionConfig[]): string[] {
  const names: string[] = [];
  for (const agent of agents) {
    names.push(agent.name);
    if (agent.subAgents) {
      names.push(...collectAgentNames(agent.subAgents));
    }
  }
  return names;
}

function findAgentByName(
  agents: AgentDefinitionConfig[],
  name: string,
): AgentDefinitionConfig | undefined {
  for (const agent of agents) {
    if (agent.name === name) return agent;
    if (agent.subAgents) {
      const found = findAgentByName(agent.subAgents, name);
      if (found) return found;
    }
  }
  return undefined;
}

// ── Extension ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let projectConfig: OrchestratorFileConfig | null = null;

  pi.on("session_start", async (_event, ctx) => {
    projectConfig = loadConfig(ctx.cwd);

    if (projectConfig) {
      const names = projectConfig.agents.map((a) => a.name);
      ctx.ui.notify(
        `ai-sdk: loaded ${names.length} agents (${names.join(", ")})`,
        "info",
      );
    }
  });

  // ── Tool: orchestrate ──

  pi.registerTool({
    name: "orchestrate",
    label: "Orchestrate",
    description:
      "Run the project's multi-agent orchestration pipeline. " +
      "Agents are defined in .pi/settings.json under the \"orchestrator\" key. " +
      "You only need to provide the task. " +
      "If no config exists, you must supply agents inline.",
    promptSnippet:
      "Run multi-agent orchestration pipeline defined in .pi/settings.json",
    promptGuidelines: [
      "Use the orchestrate tool when the user asks to run the agent pipeline, " +
      "generate code across layers, or any task that requires coordinated multi-agent work.",
      "If .pi/settings.json has an orchestrator config, just provide a task — agents are pre-configured.",
      "If no config exists, provide agents inline with name, role, rules, and optional dependsOn.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description: "The high-level task description all agents work on",
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Override default model ("provider/model-id"). Falls back to config model.',
        }),
      ),
      agents: Type.Optional(
        Type.Array(AgentDefinitionSchema, {
          description:
            "Agent definitions. Only needed if .pi/settings.json has no orchestrator config. " +
            "Agents can have nested subAgents for tree structures.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const agents: AgentDefinition[] | undefined =
        (params.agents as AgentDefinition[] | undefined) ?? projectConfig?.agents;

      if (!agents || agents.length === 0) {
        throw new Error(
          "No agents defined. Add an \"orchestrator\" section to .pi/settings.json " +
          "or pass agents inline. See the ai-sdk README for the config schema.",
        );
      }

      const model = params.model ?? projectConfig?.model;
      if (!model) {
        throw new Error(
          "No model specified. Set \"model\" in the orchestrator config in .pi/settings.json " +
          "or pass it as a parameter. Example: \"anthropic/claude-sonnet-4-5\".",
        );
      }

      const { onProgress, lines } = buildProgressHandler(onUpdate);

      const config: OrchestratorConfig = {
        agents,
        model,
        thinkingLevel: projectConfig?.thinkingLevel,
        cwd: ctx.cwd,
        manifestDir: projectConfig?.manifestDir,
        onProgress,
      };

      const app = createOrchestrator(config);
      const manifests = await app.run(params.task);

      return {
        content: [
          {
            type: "text",
            text: [
              "Orchestration complete.",
              "",
              lines.join("\n"),
              "",
              "=== Manifests ===",
              formatManifests(manifests),
            ].join("\n"),
          },
        ],
        details: { manifests },
      };
    },
  });

  // ── Tool: run_agent ──

  pi.registerTool({
    name: "run_agent",
    label: "Run Agent",
    description:
      "Run a single agent by name from the project's orchestrator config, " +
      "or define one inline. Runs only that agent — no dependency chain. " +
      "Use this when the user wants to target a specific layer or specialist.",
    promptSnippet:
      "Run a single named agent from .pi/settings.json orchestrator config",
    promptGuidelines: [
      "Use run_agent when the user wants to run a specific agent by name, e.g. " +
        '"run the schema agent to add a posts table" or "have the reviewer check my code".',
      "If the agent is defined in .pi/settings.json, just provide name + task.",
      "You can override the agent inline by providing role/rules/model/type/etc.",
      "This does NOT run dependencies — use orchestrate for the full pipeline.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          "Agent name — must match a configured agent in .pi/settings.json, " +
          "or provide role+rules to define one inline.",
      }),
      task: Type.String({
        description: "The task for this agent to perform",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Optional context to inject as upstream dependency context. " +
            "Useful when you want to provide information from previous work.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: 'Override model for this run ("provider/model-id")',
        }),
      ),
      // Inline agent overrides — used when name doesn't match config or to override fields
      role: Type.Optional(
        Type.String({ description: "Agent role (required if not in config)" }),
      ),
      rules: Type.Optional(
        Type.String({ description: "Agent rules (required if not in config)" }),
      ),
      type: Type.Optional(
        Type.String({
          description: 'Agent type: "coding", "readonly", "all", "none"',
        }),
      ),
      enabledTools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Cherry-pick tools: read, bash, edit, write, grep, find, ls",
        }),
      ),
      skills: Type.Optional(
        Type.Array(Type.String(), { description: "Skill directory paths" }),
      ),
      subAgents: Type.Optional(
        Type.Array(AgentDefinitionSchema, {
          description:
            "Nested sub-agents forming a mini-pipeline under this agent. " +
            "When provided, the agent becomes composite: sub-agents run in waves " +
            "and their manifests merge into the parent's manifest.",
        }),
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Resolve agent definition: config lookup + inline overrides (recursive search)
      const configAgent = findAgentByName(projectConfig?.agents ?? [], params.name);

      if (!configAgent && !params.role) {
        const available = collectAgentNames(projectConfig?.agents ?? []).join(", ") || "(none)";
        throw new Error(
          `Agent "${params.name}" not found in config. Available: ${available}. ` +
          "Provide role + rules to define one inline.",
        );
      }

      const agentDef: AgentDefinition = {
        name: params.name,
        role: params.role ?? configAgent?.role ?? "",
        rules: params.rules ?? configAgent?.rules ?? "",
        dependsOn: [],
        model: (params.model ?? configAgent?.model) as any,
        type: (params.type ?? configAgent?.type) as AgentType | undefined,
        enabledTools: params.enabledTools ?? configAgent?.enabledTools,
        skills: params.skills ?? configAgent?.skills,
        thinkingLevel: configAgent?.thinkingLevel,
        subAgents: (params.subAgents ?? configAgent?.subAgents) as AgentDefinition[] | undefined,
      };

      const dependencyContext =
        params.context ?? "You are running standalone — no upstream context.";

      const model = params.model ?? configAgent?.model ?? projectConfig?.model;
      if (!model) {
        throw new Error(
          "No model specified. Set \"model\" in the orchestrator config in .pi/settings.json, " +
          "on the agent definition, or pass it as a parameter. Example: \"anthropic/claude-sonnet-4-5\".",
        );
      }

      const isComposite = agentDef.subAgents && agentDef.subAgents.length > 0;

      onUpdate?.({
        content: [
          {
            type: "text",
            text: isComposite
              ? `▶ Running composite agent "${agentDef.name}" with ${agentDef.subAgents!.length} sub-agent(s) (${agentDef.model ?? model})...`
              : `▶ Running agent "${agentDef.name}" (${agentDef.model ?? model})...`,
          },
        ],
        details: {},
      });

      const agentConfig: OrchestratorConfig = {
        agents: [agentDef],
        model,
        thinkingLevel: projectConfig?.thinkingLevel,
        cwd: ctx.cwd,
        manifestDir: projectConfig?.manifestDir,
      };

      let manifest: AgentManifest;
      if (isComposite) {
        // Use orchestrator for composite agents so sub-agents are executed
        const app = createOrchestrator(agentConfig);
        const manifests = await app.run(params.task, dependencyContext);
        manifest = manifests[0];
      } else {
        manifest = await runAgent(agentDef, params.task, dependencyContext, agentConfig);
      }

      return {
        content: [
          {
            type: "text",
            text: [
              `✓ Agent "${manifest.agent}" complete.`,
              "",
              `Summary: ${manifest.summary}`,
              `Files: ${manifest.changedFiles.join(", ") || "(none)"}`,
              Object.keys(manifest.exports).length > 0
                ? `Exports:\n${Object.entries(manifest.exports)
                    .map(([sym, loc]) => `  ${sym} → ${loc}`)
                    .join("\n")}`
                : "Exports: (none)",
            ].join("\n"),
          },
        ],
        details: { manifest },
      };
    },
  });

  // ── Command: /orchestrate <task> ──

  pi.registerCommand("orchestrate", {
    description:
      "Run the agent pipeline or a single agent. Usage: /orchestrate [agent-name] <task>",
    handler: async (args, ctx) => {
      if (!projectConfig) {
        ctx.ui.notify(
          "No orchestrator config in .pi/settings.json. Add an \"orchestrator\" key — see ai-sdk README.",
          "error",
        );
        return;
      }

      const trimmed = args?.trim() ?? "";
      if (!trimmed) {
        const names = projectConfig.agents.map((a) => a.name).join(", ");
        ctx.ui.notify(
          `Usage:\n  /orchestrate <task>              — run full pipeline\n  /orchestrate <agent-name> <task> — run a single agent\n\nAvailable agents: ${names}`,
          "warning",
        );
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const firstWord = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const allAgentNames = collectAgentNames(projectConfig.agents);
      const matchedAgent = allAgentNames.find((n) => n === firstWord);

      if (matchedAgent && spaceIdx !== -1) {
        const task = trimmed.slice(spaceIdx + 1).trim();
        pi.sendUserMessage(
          `Run the run_agent tool with name="${matchedAgent}" and this task: ${task}`,
          { deliverAs: "followUp" },
        );
      } else {
        pi.sendUserMessage(
          `Run the orchestrate tool with this task: ${trimmed}`,
          { deliverAs: "followUp" },
        );
      }
    },
  });

  // ── Command: /agent <name> <task> ──

  pi.registerCommand("agent", {
    description:
      "Run a single agent by name with a task. Usage: /agent <name> <task>",
    handler: async (args, ctx) => {
      if (!projectConfig) {
        ctx.ui.notify(
          "No orchestrator config in .pi/settings.json. Add an \"orchestrator\" key — see ai-sdk README.",
          "error",
        );
        return;
      }

      const trimmed = args?.trim() ?? "";
      const spaceIdx = trimmed.indexOf(" ");
      if (!trimmed || spaceIdx === -1) {
        const names = collectAgentNames(projectConfig.agents).join(", ");
        ctx.ui.notify(
          `Usage: /agent <name> <task>\nAvailable: ${names}`,
          "warning",
        );
        return;
      }

      const name = trimmed.slice(0, spaceIdx);
      const task = trimmed.slice(spaceIdx + 1).trim();

      const agent = findAgentByName(projectConfig.agents, name);
      if (!agent) {
        const names = collectAgentNames(projectConfig.agents).join(", ");
        ctx.ui.notify(
          `Agent "${name}" not found. Available: ${names}`,
          "error",
        );
        return;
      }

      pi.sendUserMessage(
        `Run the run_agent tool with name="${name}" and this task: ${task}`,
        { deliverAs: "followUp" },
      );
    },
  });

  // ── Command: /orch-agents ──

  pi.registerCommand("orch-agents", {
    description: "List all configured orchestrator agents from .pi/settings.json",
    handler: async (_args, ctx) => {
      if (!projectConfig) {
        ctx.ui.notify(
          "No orchestrator config in .pi/settings.json. Add an \"orchestrator\" key — see ai-sdk README.",
          "error",
        );
        return;
      }

      const pipelineAgents = projectConfig.agents.filter((a) => !a.standalone);
      const standaloneAgents = projectConfig.agents.filter((a) => a.standalone);

      function formatAgent(
        a: AgentDefinitionConfig,
        indent: string,
        bullet: string,
        defaultModel: string,
      ): string[] {
        const deps = a.dependsOn?.length
          ? `depends on: ${a.dependsOn.join(", ")}`
          : "no dependencies";
        const model = a.model ?? defaultModel;
        const type = a.type ?? "coding";
        const subLabel = a.subAgents?.length ? ` [composite: ${a.subAgents.length} sub-agent(s)]` : "";
        const result = [`${indent}${bullet} ${a.name} (${type}, ${model}) — ${a.role} [${deps}]${subLabel}`];
        if (a.subAgents) {
          for (const sub of a.subAgents) {
            result.push(...formatAgent(sub, indent + "  ", "↳", a.model ?? defaultModel));
          }
        }
        return result;
      }

      const defaultModel = projectConfig!.model ?? "default";
      const lines: string[] = [];
      for (const a of pipelineAgents) {
        lines.push(...formatAgent(a, "  ", "•", defaultModel));
      }

      if (standaloneAgents.length > 0) {
        lines.push("");
        lines.push("Standalone (not in pipeline):");
        for (const a of standaloneAgents) {
          lines.push(...formatAgent(a, "  ", "◦", defaultModel));
        }
      }

      ctx.ui.notify(
        [
          `Configured agents (${projectConfig.agents.length}):`,
          ...lines,
          "",
          "Run one:  /agent <name> <task>",
          "Run all:  /orchestrate <task>",
          "List:     /orch-agents",
        ].join("\n"),
        "info",
      );
    },
  });
}
