/**
 * Code-intel extension registration.
 *
 * Registers three tools: code_map, code_outline, find_references.
 * Loads config from `.pi/settings.json` → `codeIntel` key.
 *
 * All tools fall back to grep/rg on any failure — the model always
 * gets something useful.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { LanguageRegistry } from "./languages.js";
import { createLogger } from "./logger.js";
import { executeCodeMap, executeCodeOutline, executeFindReferences } from "./tools.js";
import type { CodeIntelConfig } from "./types.js";
import type pino from "pino";

// ── Config loading ─────────────────────────────────────────

function loadCodeIntelConfig(cwd: string, log: pino.Logger): CodeIntelConfig | undefined {
  const settingsPath = path.resolve(cwd, ".pi/settings.json");
  try {
    if (!fs.existsSync(settingsPath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (raw.codeIntel && typeof raw.codeIntel === "object") {
      log.info({ path: settingsPath }, "Loaded codeIntel config");
      return raw.codeIntel as CodeIntelConfig;
    }
  } catch (err) {
    log.warn({ err, path: settingsPath }, "Failed to read codeIntel config");
  }
  return undefined;
}

// ── Registration ───────────────────────────────────────────

export function registerCodeIntelTools(pi: ExtensionAPI): void {
  let registry: LanguageRegistry = new LanguageRegistry();
  let log: pino.Logger = createLogger("info");

  // Re-initialize on session start (picks up project-specific config)
  pi.on("session_start", async (_event, ctx) => {
    const config = loadCodeIntelConfig(ctx.cwd, log);
    registry = new LanguageRegistry(config);

    if (config?.logLevel) {
      log = createLogger(config.logLevel as pino.Level);
    }

    const langCount = registry.all().length;
    const extCount = registry.allExtensions().length;
    log.info(
      { langCount, extCount, hasConfig: !!config },
      "code-intel: initialized",
    );
  });

  // ── code_map ──

  pi.registerTool({
    name: "code_map",
    label: "Code Map",
    description:
      "Get a structural overview of a directory: file tree with one-line summaries of " +
      "each file's exports and declarations. Much faster than reading every file. " +
      "Use this to orient yourself in a codebase before diving into specific files.",
    promptSnippet: "Structural directory tree with file export summaries",
    promptGuidelines: [
      "Use code_map to understand project structure before using read or grep.",
      "Prefer code_map over ls or find when you need to understand what files contain.",
      "Use code_outline for detailed view of a single file after code_map shows you what exists.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: 'Directory path relative to cwd (default: ".")' }),
      ),
      depth: Type.Optional(
        Type.Number({ description: "Max directory depth 1-5 (default: 3)" }),
      ),
      include_summary: Type.Optional(
        Type.Boolean({ description: "Include per-file export summaries (default: true, set false for speed)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeCodeMap(params, ctx.cwd, registry, log);
    },
  });

  // ── code_outline ──

  pi.registerTool({
    name: "code_outline",
    label: "Code Outline",
    description:
      "Get the structural skeleton of a file: imports, exports, classes with methods, " +
      "functions with signatures, types, interfaces. Returns ~50 tokens instead of ~500 " +
      "from reading the whole file. Use this before `read` to know exactly where to look.",
    promptSnippet: "File structural skeleton: imports, exports, classes, functions, types",
    promptGuidelines: [
      "Use code_outline before read to understand a file's structure without consuming tokens on the full content.",
      "After code_outline, use read with offset/limit to zoom into the specific section you need.",
      "code_outline works for .ts, .tsx, .js, .jsx files. Falls back to grep for others.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to cwd" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeCodeOutline(params, ctx.cwd, registry, log);
    },
  });

  // ── find_references ──

  pi.registerTool({
    name: "find_references",
    label: "Find References",
    description:
      "Find all references to a symbol across the codebase: definitions, imports, " +
      "exports, and usages. Grouped by type for easy scanning. More reliable than " +
      "grep for understanding how a symbol is used — distinguishes definition from usage.",
    promptSnippet: "Find all references to a symbol: definitions, imports, usages",
    promptGuidelines: [
      "Use find_references instead of grep/rg when you need to understand how a specific symbol is used.",
      "find_references classifies each match as definition, import, export, or usage.",
      "Scope to a subdirectory with the path parameter to narrow results.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to search for" }),
      path: Type.Optional(
        Type.String({ description: 'Scope search to this directory (default: ".")' }),
      ),
      exact: Type.Optional(
        Type.Boolean({ description: "Word-boundary matching (default: true)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeFindReferences(params, ctx.cwd, registry, log);
    },
  });
}
