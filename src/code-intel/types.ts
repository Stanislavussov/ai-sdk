/**
 * Types for the code-intel module.
 *
 * Every function returns *something* useful even when the primary parser
 * fails.  The `fallback` / `error` fields let callers and tests know
 * what path was taken.
 */

// ── Language configuration ─────────────────────────────────

/**
 * Describes how code-intel handles a language.
 *
 * Built-in: TypeScript / JavaScript / React (tsx/jsx).
 * Extend via `.pi/settings.json` → `codeIntel.languages`.
 */
export interface LanguageConfig {
  /** Unique identifier, e.g. "typescript" */
  id: string;
  /** Human-readable name, e.g. "TypeScript" */
  name: string;
  /** File extensions including the dot: [".ts", ".tsx"] */
  extensions: string[];
  /**
   * Which built-in parser to use.
   *
   * - `"typescript"` — full structural parser (imports, exports, classes, interfaces, etc.)
   * - `"regex"`      — generic line-by-line regex matcher using `patterns` below
   * - `"none"`       — no parsing; file appears in code_map but outline is grep-only
   */
  parser: "typescript" | "regex" | "none";
  /**
   * Custom regex patterns for the `"regex"` parser.
   * Each key maps to a declaration kind; value is a regex string with
   * a **named capture group `name`** for the identifier.
   *
   * Example for Python:
   * ```json
   * {
   *   "function": "^(?:async\\s+)?def\\s+(?<name>\\w+)",
   *   "class": "^class\\s+(?<name>\\w+)",
   *   "import": "^(?:import|from)\\s+(?<name>.+)"
   * }
   * ```
   */
  patterns?: Record<string, string>;
  /** Single-line comment prefix, e.g. "//" or "#".  Default: "//" */
  commentPrefix?: string;
}

/**
 * Top-level code-intel configuration.
 * Loaded from `.pi/settings.json` → `codeIntel` key.
 */
export interface CodeIntelConfig {
  /** Additional language definitions (merged with built-ins; same `id` overrides) */
  languages?: LanguageConfig[];
  /** Extra directories to ignore in code_map (merged with defaults) */
  ignoreDirs?: string[];
  /** Extra file extensions to ignore in code_map */
  ignoreExtensions?: string[];
  /** Log level override: "debug" | "info" | "warn" | "error" */
  logLevel?: string;
}

// ── Outline ────────────────────────────────────────────────

export type EntryKind =
  | "import"
  | "export"
  | "re-export"
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "method"
  | "property"
  | "constructor"
  | "getter"
  | "setter"
  | "namespace";

export interface OutlineEntry {
  kind: EntryKind;
  name: string;
  line: number;
  endLine?: number;
  /** Compact signature, e.g. "(a, b?) → Promise<T>" */
  signature?: string;
  exported: boolean;
  isDefault?: boolean;
  /** Module specifier for imports / re-exports */
  source?: string;
  /** Class / interface members */
  children?: OutlineEntry[];
}

export interface FileOutline {
  path: string;
  lines: number;
  language: string;
  entries: OutlineEntry[];
  /** Non-fatal issues encountered during parsing */
  warnings?: string[];
  /** True when the result came from the grep fallback */
  fallback?: boolean;
}

// ── Code map ───────────────────────────────────────────────

export interface MapEntry {
  path: string;
  type: "file" | "directory";
  /** One-line summary for files (primary exports / declarations) */
  summary?: string;
  children?: MapEntry[];
}

export interface CodeMap {
  root: string;
  entries: MapEntry[];
  truncated?: boolean;
  /** True when the result came from the fallback */
  fallback?: boolean;
  error?: string;
}

// ── References ─────────────────────────────────────────────

export type ReferenceKind = "definition" | "import" | "export" | "usage";

export interface Reference {
  file: string;
  line: number;
  text: string;
  kind: ReferenceKind;
}

export interface ReferenceResult {
  symbol: string;
  references: Reference[];
  /** True when the result came from grep/rg fallback */
  fallback: boolean;
  error?: string;
}

// ── Tool result (matches pi tool contract) ─────────────────

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
}
