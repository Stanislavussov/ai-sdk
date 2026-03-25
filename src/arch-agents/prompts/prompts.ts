import type { AgentDefinition } from "../types.js";

function buildSiblingBoundaries(
  def: AgentDefinition,
  siblings: AgentDefinition[],
): string[] {
  const others = siblings.filter((s) => s.name !== def.name);
  if (others.length === 0) return [];

  const lines: string[] = [
    "## ⛔ Other agents in this pipeline — their domains are OFF-LIMITS",
    "The following agents own their respective areas. You MUST NOT read, create, modify,",
    "or delete any files that belong to them. If in doubt, leave it alone.",
    "",
  ];

  for (const sibling of others) {
    lines.push(`- **${sibling.name}**: ${sibling.role}`);
  }

  lines.push(
    "",
    "Violating another agent's boundary will cause conflicts and break the pipeline.",
    "",
  );

  return lines;
}

export function buildAgentSystemPrompt(
  def: AgentDefinition,
  dependencyContext: string,
  siblings?: AgentDefinition[],
): string {
  // Check if agent has write capability
  const hasWrite = def.enabledTools
    ? def.enabledTools.includes("write")
    : (def.type ?? "coding") !== "readonly" && (def.type ?? "coding") !== "none";

  const manifestInstructions = hasWrite
    ? [
        "## ⚠️ CRITICAL RESPONSIBILITIES ⚠️",
        "1. Stay strictly within your layer - do not modify files owned by other agents",
        "2. When complete, YOU MUST write a manifest JSON file to the path specified in the task prompt",
        "   - Use the 'write' tool with the exact path provided",
        "   - Write pure JSON only (no markdown fences, no extra text)",
        "   - Use schema: { changedFiles: string[], summary: string, exports: Record<string,string> }",
        '   - Example: { "changedFiles": ["src/api.ts"], "summary": "Added API", "exports": { "API": "src/api.ts:1" } }',
        "3. DO NOT finish your response until the manifest file is written",
        "4. The orchestration will FAIL if you don't write the manifest file",
      ]
    : [
        "## Responsibilities",
        "1. You are a read-only agent — do NOT create, modify, or delete any files",
        "2. Provide your analysis/findings directly in your response text",
        "3. Be thorough but concise",
      ];

  const siblingSection = siblings ? buildSiblingBoundaries(def, siblings) : [];

  return [
    `You are the ${def.name} agent, responsible for the ${def.role}.`,
    "",
    "## Scope boundary",
    "You MUST only perform work that falls within your defined role and rules above.",
    "You CANNOT do anything outside your responsibility — even if the task or context mentions it.",
    "If part of the task touches another agent's domain, ignore that part completely.",
    "",
    ...siblingSection,
    "## When to skip",
    "If the task does not require any action from you — because it is unrelated to your role,",
    "or your role's area already satisfies the task, or there is simply nothing for you to do —",
    "then SKIP immediately: do not read files, do not explore, do not make changes.",
    "Just write the manifest (if applicable) with an empty changedFiles and a summary",
    'explaining why you skipped (e.g. "Task does not involve my responsibility area").',
    "",
    "## Your Rules",
    def.rules,
    "",
    "## Context from upstream agents",
    dependencyContext,
    "",
    ...manifestInstructions,
  ].join("\n");
}

export function buildReadOnlyTaskPrompt(task: string): string {
  return [
    "## Task",
    task,
    "",
    "If this task has nothing to do with your role, respond with a single line: 'SKIP: not in my scope.'",
    "Otherwise, provide your analysis directly in your response. Do NOT create or modify any files.",
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
