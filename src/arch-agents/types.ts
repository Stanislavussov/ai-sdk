import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentType, ModelId, ThinkingLevel } from "./constants.js";

export type { AgentType, ModelId, ThinkingLevel } from "./constants.js";

export interface AgentDefinition {
  name: string;
  role: string;
  rules: string;
  dependsOn?: string[];
  model?: ModelId;
  /**
   * Agent type — selects which built-in tools are available.
   * @default "coding"
   */
  type?: AgentType;
  /**
   * Specific built-in tools to enable.
   * Overrides `type` when provided.
   * Valid names: "read", "bash", "edit", "write", "grep", "find", "ls"
   */
  enabledTools?: string[];
  tools?: AgentTool<any>[];
  skills?: string[];
  thinkingLevel?: ThinkingLevel;
  /**
   * When true, the agent is excluded from the default orchestration pipeline.
   * It can still be run individually via `run_agent` or `/agent <name> <task>`.
   * @default false
   */
  standalone?: boolean;
  /**
   * Nested sub-agents that form a mini-pipeline under this agent.
   *
   * When an agent has `subAgents`, it becomes a **composite agent**:
   * - Sub-agents run in waves according to their own `dependsOn` (referencing siblings).
   * - Sub-agents inherit `model` and `thinkingLevel` from the parent if not specified.
   * - The parent's upstream dependency context is forwarded to root sub-agents.
   * - The composite agent's manifest merges all sub-agent manifests.
   * - Sub-agents can themselves have `subAgents` (recursive nesting).
   *
   * Progress events for sub-agents use qualified names: "parent/child" (or "a/b/c" for deeper nesting).
   */
  subAgents?: AgentDefinition[];
}

export interface AgentManifest {
  agent: string;
  changedFiles: string[];
  summary: string;
  exports: Record<string, string>;
}

export interface OrchestratorConfig {
  agents: AgentDefinition[];
  cwd?: string;
  /**
   * Default model for all agents.
   * Individual agents can override with their own `model` field.
   * Format: "provider/model-id" (e.g. "anthropic/claude-sonnet-4-5").
   */
  model: ModelId;
  thinkingLevel?: ThinkingLevel;
  onProgress?: (event: ProgressEvent) => void;
  manifestDir?: string;
}

export type ProgressEvent =
  | { type: "wave_start"; wave: number; agents: string[] }
  | { type: "agent_start"; agent: string; model: string }
  | { type: "agent_done"; agent: string; manifest: AgentManifest }
  | { type: "agent_error"; agent: string; error: Error }
  | { type: "orchestrator_done"; manifests: AgentManifest[] }
  | {
      /**
       * Informal, human-readable status of what an agent is currently doing.
       * Emitted in real time as the agent works (e.g. "Reading src/index.ts",
       * "Running: npm test", "Thinking…").
       */
      type: "agent_activity";
      agent: string;
      message: string;
    }
  | {
      /**
       * Emitted after every agent completes, showing the full accumulated
       * state of the ManifestBus. Useful for debugging context propagation
       * and verifying that all upstream knowledge is available.
       */
      type: "bus_snapshot";
      /** The agent that just finished and triggered this snapshot */
      afterAgent: string;
      /** All manifests currently in the bus (in insertion order) */
      manifests: AgentManifest[];
      /** The full context string that the NEXT agent would receive */
      contextForNext: string;
    };
