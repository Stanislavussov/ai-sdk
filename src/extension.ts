import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createOrchestrator } from "./arch-agents/index.js";
import type { AgentDefinition, AgentManifest, AgentType, OrchestratorConfig, ProgressEvent } from "./arch-agents/types.js";

// ── Config schema ──────────────────────────────────────────
// Loaded from .pi/settings.json → "orchestrator" key

interface OrchestratorFileConfig {
  model?: string;
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
}

// ── Config loading ─────────────────────────────────────────

function loadConfig(cwd: string): OrchestratorFileConfig | null {
  // Primary: .pi/settings.json → "orchestrator" key
  const settingsPath = path.resolve(cwd, ".pi/settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (raw.orchestrator && Array.isArray(raw.orchestrator.agents)) {
        return raw.orchestrator as OrchestratorFileConfig;
      }
    } catch {
      // ignore parse errors
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
            'Override default model ("provider/model-id"). Falls back to config, then to pi default.',
        }),
      ),
      agents: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "Unique agent identifier" }),
            role: Type.String({ description: "What this agent is responsible for" }),
            rules: Type.String({ description: "Constraints and style rules" }),
            dependsOn: Type.Optional(
              Type.Array(Type.String(), {
                description: "Agent names this agent depends on",
              }),
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
                description:
                  "Cherry-pick specific tools: read, bash, edit, write, grep, find, ls. Overrides type.",
              }),
            ),
            skills: Type.Optional(
              Type.Array(Type.String(), { description: "Skill directory paths" }),
            ),
          }),
          {
            description:
              "Agent definitions. Only needed if .pi/settings.json has no orchestrator config.",
          },
        ),
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

      const { onProgress, lines } = buildProgressHandler(onUpdate);

      const config: OrchestratorConfig = {
        agents,
        model: params.model ?? projectConfig?.model,
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

  // ── Command: /orchestrate <task> ──

  pi.registerCommand("orchestrate", {
    description:
      "Run the agent pipeline from .pi/settings.json with the given task",
    handler: async (args, ctx) => {
      if (!projectConfig) {
        ctx.ui.notify(
          "No orchestrator config in .pi/settings.json. Add an \"orchestrator\" key — see ai-sdk README.",
          "error",
        );
        return;
      }

      const task = args?.trim();
      if (!task) {
        ctx.ui.notify("Usage: /orchestrate <task description>", "warning");
        return;
      }

      pi.sendUserMessage(
        `Run the orchestrate tool with this task: ${task}`,
        { deliverAs: "followUp" },
      );
    },
  });
}
