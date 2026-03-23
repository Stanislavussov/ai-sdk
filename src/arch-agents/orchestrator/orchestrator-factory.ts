import { Orchestrator } from "./orchestrator.js";
import type { AgentManifest, OrchestratorConfig } from "../types.js";

export function createOrchestrator(
  config: OrchestratorConfig,
): { run(task: string, parentContext?: string): Promise<AgentManifest[]> } {
  return new Orchestrator(config);
}
