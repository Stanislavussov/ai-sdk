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
    "## ⚠️ CRITICAL RESPONSIBILITIES ⚠️",
    "1. Stay strictly within your layer - do not modify files owned by other agents",
    "2. When complete, YOU MUST write a manifest JSON file to the path specified in the task prompt",
    "   - Use the 'write' tool with the exact path provided",
    "   - Write pure JSON only (no markdown fences, no extra text)",
    "   - Use schema: { changedFiles: string[], summary: string, exports: Record<string,string> }",
    "   - Example: { \"changedFiles\": [\"src/api.ts\"], \"summary\": \"Added API\", \"exports\": { \"API\": \"src/api.ts:1\" } }",
    "3. DO NOT finish your response until the manifest file is written",
    "4. The orchestration will FAIL if you don't write the manifest file",
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
    "## ⚠️ CRITICAL REQUIREMENT: Write Manifest File ⚠️",
    "",
    "YOU MUST COMPLETE THIS STEP - DO NOT FINISH WITHOUT DOING THIS:",
    "",
    `1. Use the 'write' tool to create the file: ${manifestPath}`,
    "2. Write ONLY valid JSON (no markdown code fences, no extra text)",
    "3. Use this exact schema:",
    "   {",
    '     "changedFiles": ["array", "of", "file", "paths"],',
    '     "summary": "brief description of what you did",',
    '     "exports": { "SymbolName": "file.ts:lineNumber" }',
    "   }",
    "",
    "Example:",
    '{ "changedFiles": ["src/api.ts"], "summary": "Added user endpoint", "exports": { "UserAPI": "src/api.ts:10" } }',
    "",
    "⚠️ THE ORCHESTRATOR WILL FAIL IF YOU DON'T WRITE THIS FILE ⚠️",
    "Do not respond with completion until the manifest file has been written using the write tool.",
  ].join("\n");
}
