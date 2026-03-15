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
  | { type: "orchestrator_done"; manifests: AgentManifest[] };
