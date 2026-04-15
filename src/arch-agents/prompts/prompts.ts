import type { AgentDefinition } from "../types.js";

function buildSiblingBoundaries(
  def: AgentDefinition,
  siblings: AgentDefinition[],
): string[] {
  const others = siblings.filter((s) => s.name !== def.name);
  if (others.length === 0) return [];

  return [
    "## ⛔ Other agents — their files are OFF-LIMITS",
    ...others.map((s) => `- **${s.name}**: ${s.role}`),
    "Do not read, create, or modify files in other agents' domains.",
    "",
  ];
}

export function buildAgentSystemPrompt(
  def: AgentDefinition,
  dependencyContext: string,
  siblings?: AgentDefinition[],
): string {
  const hasWrite = def.enabledTools
    ? def.enabledTools.includes("write")
    : (def.type ?? "coding") !== "readonly" && (def.type ?? "coding") !== "none";

  const hasCodeIntel = def.enabledTools
    ? def.enabledTools.includes("code-intel")
    : true;

  const codeIntel = hasCodeIntel
    ? [
        "",
        "## 🔍 Code Exploration (code-intel)",
        "**code_map** → directory structure with exports",
        "**code_outline** → file skeleton (imports, classes, functions, signatures)",
        "**find_references** → symbol usage across codebase",
        "Use these before read/grep. Supports TS/JS/React (+ custom via config).",
        "",
      ]
    : [];

  const manifest = hasWrite
    ? [
        "## ⚠️ Write manifest file when done:",
        `  { "changedFiles": [], "summary": "...", "exports": {} }`,
        "Use 'write' tool. Pure JSON only. Required — orchestrator fails without it.",
        "",
      ]
    : [
        "## Read-only — provide analysis in response, no file changes.",
        "",
      ];

  const skipNote = [
    "## Skip rule",
    "If the task doesn't involve your domain, respond: SKIP: not in my scope.",
    "Or write manifest with empty changedFiles.",
    "",
  ];

  const sections: string[] = [
    `You are the ${def.name} agent, responsible for ${def.role}.`,
    "",
    ...codeIntel,
    ...skipNote,
    ...(siblings ? buildSiblingBoundaries(def, siblings) : []),
    "## Your Rules",
    def.rules,
    "",
    "## Upstream Context",
    dependencyContext,
    "",
    ...manifest,
  ];

  return sections.join("\n");
}

export function buildReadOnlyTaskPrompt(task: string): string {
  return `## Task\n${task}\n\nIf unrelated to your role: SKIP: not in my scope.\nOtherwise, provide analysis in your response. No file changes.`;
}

export function buildOrchestratorTaskPrompt(
  task: string,
  manifestPath: string,
): string {
  return [
    `## Task\n${task}`,
    "",
    `## ⚠️ Required: Write manifest to ${manifestPath}`,
    '```json\n{ "changedFiles": [], "summary": "...", "exports": {} }\n```',
    "Use 'write' tool. Pure JSON only. Orchestrator fails without this file.",
  ].join("\n");
}
