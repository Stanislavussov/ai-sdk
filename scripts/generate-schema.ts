/**
 * Generates schema.json from runtime constants.
 *
 * Run: npx tsx scripts/generate-schema.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_TYPES,
  KNOWN_MODELS,
  THINKING_LEVELS,
  TOOL_NAMES,
} from "../src/arch-agents/constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://github.com/ai-sdk/settings-schema",
  title: "ai-sdk Settings",
  description:
    'Extends .pi/settings.json with the "orchestrator" key for multi-agent pipeline configuration.',
  type: "object" as const,
  properties: {
    $schema: { type: "string" as const },
    packages: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Pi packages to load (pi's own field).",
    },
    extensions: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Extension paths to load (pi's own field).",
    },
    orchestrator: { $ref: "#/$defs/orchestratorConfig" },
  },
  $defs: {
    orchestratorConfig: {
      type: "object" as const,
      description: "Multi-agent orchestration pipeline configuration.",
      required: ["agents"],
      additionalProperties: false,
      properties: {
        model: {
          $ref: "#/$defs/modelId",
          description:
            "Default model for all agents. Individual agents can override with their own model field.",
        },
        thinkingLevel: {
          $ref: "#/$defs/thinkingLevel",
          description: "Default thinking level for all agents.",
        },
        manifestDir: {
          type: "string" as const,
          description:
            "Temp directory for manifest exchange between agents. Defaults to OS temp directory.",
        },
        agents: {
          type: "array" as const,
          description:
            "Agent definitions that form the orchestration pipeline.",
          minItems: 1,
          items: { $ref: "#/$defs/agentDefinition" },
        },
      },
    },
    thinkingLevel: {
      type: "string" as const,
      enum: [...THINKING_LEVELS],
      description:
        "Controls how much reasoning the model does before responding.",
    },
    agentType: {
      type: "string" as const,
      enum: [...AGENT_TYPES],
      description: [
        "Selects which built-in tools the agent receives.",
        "",
        "- coding (default): read, bash, edit, write",
        "- readonly: read, grep, find, ls",
        "- all: every built-in tool",
        "- none: no built-in tools",
      ].join("\n"),
    },
    toolName: {
      type: "string" as const,
      enum: [...TOOL_NAMES],
      description: "Name of a built-in tool.",
    },
    modelId: {
      type: "string" as const,
      description: 'Model identifier in "provider/model-id" format.',
      anyOf: [
        { enum: [...KNOWN_MODELS] },
        {
          type: "string" as const,
          pattern: "^[a-zA-Z0-9_-]+/[a-zA-Z0-9._-]+$",
        },
      ],
    },
    agentDefinition: {
      type: "object" as const,
      required: ["name", "role", "rules"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string" as const,
          description:
            "Unique identifier for this agent. Used in dependsOn references and progress output.",
          pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$",
        },
        role: {
          type: "string" as const,
          description:
            "What this agent is responsible for. Included in the agent's system prompt.",
        },
        rules: {
          type: "string" as const,
          description:
            "Constraints, style rules, and guidelines for this agent. Included in the agent's system prompt.",
        },
        dependsOn: {
          type: "array" as const,
          items: { type: "string" as const },
          uniqueItems: true,
          description:
            "Names of agents that must complete before this one starts. Agents with no dependencies run in the first wave.",
        },
        model: {
          $ref: "#/$defs/modelId",
          description:
            "Model override for this agent. Falls back to the top-level model.",
        },
        type: {
          $ref: "#/$defs/agentType",
          default: "coding",
          description: [
            "Agent type — selects which built-in tools are available.",
            "",
            "- coding (default): read, bash, edit, write",
            "- readonly: read, grep, find, ls",
            "- all: every built-in tool",
            "- none: no built-in tools",
          ].join("\n"),
        },
        enabledTools: {
          type: "array" as const,
          items: { $ref: "#/$defs/toolName" },
          uniqueItems: true,
          description:
            "Cherry-pick specific built-in tools. Overrides the type field when provided.",
        },
        skills: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Paths to skill directories (resolved relative to project root). Each directory should contain a SKILL.md file.",
        },
        thinkingLevel: {
          $ref: "#/$defs/thinkingLevel",
          description:
            "Thinking level override for this agent. Falls back to the top-level thinkingLevel.",
        },
        standalone: {
          type: "boolean" as const,
          default: false,
          description:
            "When true, exclude this agent from the orchestration pipeline. " +
            "It can still be run individually via run_agent or /agent <name> <task>.",
        },
      },
    },
  },
};

const outPath = path.resolve(__dirname, "..", "schema.json");
fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n");

const modelCount = KNOWN_MODELS.length;
const agentTypeCount = AGENT_TYPES.length;
const toolCount = TOOL_NAMES.length;
console.log(
  `schema.json generated (${modelCount} models, ${agentTypeCount} agent types, ${toolCount} tools)`,
);
