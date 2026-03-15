import type { AgentDefinition } from "../types.js";

export function buildAgentSystemPrompt(
  def: AgentDefinition,
  dependencyContext: string,
): string {
  return [
    `You are the ${def.name} agent, responsible for the ${def.role}.`,
    "",
    "## Your Rules",
    def.rules,
    "",
    "## Context from upstream agents",
    dependencyContext,
    "",
    "## Responsibilities",
    "- Stay strictly within your layer",
    "- Do not modify files owned by other agents",
    "- When complete, write manifest JSON to the path in the task prompt",
    "- Manifest schema: { changedFiles, summary, exports }",
  ].join("\n");
}

export function buildOrchestratorTaskPrompt(
  task: string,
  manifestPath: string,
): string {
  return [
    "## Task",
    task,
    "",
    "## Required: write your manifest",
    `Write valid JSON (no markdown fences) to: ${manifestPath}`,
    "Schema: { changedFiles: string[], summary: string, exports: Record<string,string> }",
    "Do not stop until the manifest file has been written.",
  ].join("\n");
}
