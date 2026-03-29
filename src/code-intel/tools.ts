/**
 * Tool execute functions for code_map, code_outline, find_references.
 *
 * Every function follows the same contract:
 * 1. Try the structural parser first
 * 2. On failure → fall back to grep/rg
 * 3. On fallback failure → return a helpful error message suggesting `read`
 * 4. Never throw — always return a ToolResult
 *
 * Functions are pure (no pi dependency) so they can be unit-tested directly.
 */

import fs from "node:fs";
import path from "node:path";
import type pino from "pino";
import type { LanguageRegistry } from "./languages.js";
import type { FileOutline, MapEntry, OutlineEntry, Reference, ToolResult } from "./types.js";
import { parseFile, getFileSummary } from "./parser.js";
import { grepOutline, grepReferences, fallbackCodeMap } from "./fallback.js";

// ── Constants ──────────────────────────────────────────────

const MAX_MAP_ENTRIES = 300;
const MAX_MAP_DEPTH = 5;
const MAX_REF_RESULTS = 100;

// ── code_map ───────────────────────────────────────────────

export interface CodeMapParams {
  path?: string;
  depth?: number;
  /** When false, skip per-file summaries (faster for huge projects) */
  include_summary?: boolean;
}

export async function executeCodeMap(
  params: CodeMapParams,
  cwd: string,
  registry: LanguageRegistry,
  log: pino.Logger,
): Promise<ToolResult> {
  const targetPath = normalizePath(params.path ?? ".");
  const maxDepth = Math.min(params.depth ?? 3, MAX_MAP_DEPTH);
  const includeSummary = params.include_summary !== false;
  const absPath = path.resolve(cwd, targetPath);

  log.info({ targetPath, maxDepth, includeSummary }, "code_map: starting");

  // Validate path exists
  if (!safeExists(absPath)) {
    return errorResult(`Directory not found: ${targetPath}. Check the path and try again.`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    log.error({ err, absPath }, "code_map: cannot stat path");
    return tryFallbackMap(targetPath, cwd, maxDepth, registry, log);
  }

  if (!stat.isDirectory()) {
    return errorResult(`Path is a file, not a directory: ${targetPath}. Use code_outline for files.`);
  }

  try {
    let entryCount = 0;
    let truncated = false;

    const entries = walkDir(absPath, targetPath, 0, maxDepth, registry, includeSummary, log, () => {
      entryCount++;
      if (entryCount > MAX_MAP_ENTRIES) {
        truncated = true;
        return true; // signal: stop walking
      }
      return false;
    });

    const text = formatMapTree(entries, "");
    const suffix = truncated ? `\n\n(Truncated at ${MAX_MAP_ENTRIES} entries. Use a narrower path or increase depth.)` : "";

    log.info({ targetPath, entryCount, truncated }, "code_map: complete");

    return {
      content: [{ type: "text", text: `${targetPath}/ (${entryCount} items)\n\n${text}${suffix}` }],
      details: { entries, truncated, fallback: false },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, targetPath }, "code_map: primary walk failed, trying fallback");
    return tryFallbackMap(targetPath, cwd, maxDepth, registry, log);
  }
}

function tryFallbackMap(
  targetPath: string,
  cwd: string,
  maxDepth: number,
  registry: LanguageRegistry,
  log: pino.Logger,
): ToolResult {
  try {
    const ignoreDirs = new Set<string>();
    // Gather from registry
    for (const dir of ["node_modules", ".git", "dist", "build", ".next", "coverage"]) {
      if (registry.isIgnoredDir(dir)) ignoreDirs.add(dir);
    }
    // Add common ones
    ignoreDirs.add("node_modules");
    ignoreDirs.add(".git");

    const fallback = fallbackCodeMap(targetPath, cwd, maxDepth, ignoreDirs, log);
    if (fallback.error) {
      return errorResult(`code_map failed: ${fallback.error}. Use \`bash\` with \`find\` or \`ls -R\` to explore.`);
    }

    const text = formatMapTree(fallback.entries, "");
    return {
      content: [{ type: "text", text: `${targetPath}/ (fallback — no summaries)\n\n${text}` }],
      details: { entries: fallback.entries, truncated: false, fallback: true },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "code_map: fallback also failed");
    return errorResult(`code_map failed completely: ${msg}. Use \`bash\` with \`find\` or \`ls -R\` to explore the directory.`);
  }
}

// ── code_outline ───────────────────────────────────────────

export interface CodeOutlineParams {
  path: string;
}

export async function executeCodeOutline(
  params: CodeOutlineParams,
  cwd: string,
  registry: LanguageRegistry,
  log: pino.Logger,
): Promise<ToolResult> {
  const filePath = normalizePath(params.path);
  const absPath = path.resolve(cwd, filePath);

  log.info({ filePath }, "code_outline: starting");

  // Validate
  if (!safeExists(absPath)) {
    return errorResult(`File not found: ${filePath}. Check the path and try again.`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    log.error({ err, absPath }, "code_outline: cannot stat file");
    return tryFallbackOutline(filePath, cwd, log);
  }

  if (stat.isDirectory()) {
    return errorResult(`Path is a directory: ${filePath}. Use code_map for directories, code_outline for files.`);
  }

  let content: string;
  try {
    content = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    log.error({ err, absPath }, "code_outline: cannot read file");
    return tryFallbackOutline(filePath, cwd, log);
  }

  // Try structural parse
  try {
    const outline = parseFile(content, filePath, registry, log);

    if (outline.entries.length === 0 && !outline.warnings?.length) {
      // Empty file or no recognizable structure — try fallback
      log.info({ filePath }, "code_outline: parser returned nothing, trying fallback");
      return tryFallbackOutline(filePath, cwd, log);
    }

    const text = formatOutline(outline);

    log.info({ filePath, entryCount: outline.entries.length, warnings: outline.warnings?.length ?? 0 }, "code_outline: complete");

    return {
      content: [{ type: "text", text }],
      details: { outline, fallback: false },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, filePath }, "code_outline: parser crashed, trying fallback");
    return tryFallbackOutline(filePath, cwd, log);
  }
}

function tryFallbackOutline(filePath: string, cwd: string, log: pino.Logger): ToolResult {
  try {
    const outline = grepOutline(filePath, cwd, log);

    if (outline.entries.length === 0) {
      const warnMsg = outline.warnings?.join("; ") ?? "";
      return {
        content: [{
          type: "text",
          text: `${filePath}: no recognizable structure found${warnMsg ? ` (${warnMsg})` : ""}.\nUse \`read\` tool to inspect the file directly.`,
        }],
        details: { outline, fallback: true },
      };
    }

    const text = formatOutline(outline);
    return {
      content: [{ type: "text", text: `${text}\n\n(grep fallback — structural parser was not available)` }],
      details: { outline, fallback: true },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "code_outline: fallback also failed");
    return errorResult(`code_outline failed: ${msg}. Use \`read\` tool to inspect the file.`);
  }
}

// ── find_references ────────────────────────────────────────

export interface FindReferencesParams {
  symbol: string;
  path?: string;
  /** Word-boundary matching. Default: true */
  exact?: boolean;
}

export async function executeFindReferences(
  params: FindReferencesParams,
  cwd: string,
  registry: LanguageRegistry,
  log: pino.Logger,
): Promise<ToolResult> {
  const symbol = params.symbol.trim();
  const scope = normalizePath(params.path ?? ".");
  const exact = params.exact !== false;

  if (!symbol) {
    return errorResult("Symbol name is required. Provide the identifier you want to find.");
  }

  log.info({ symbol, scope, exact }, "find_references: starting");

  const absScope = path.resolve(cwd, scope);
  if (!safeExists(absScope)) {
    return errorResult(`Path not found: ${scope}. Check the path and try again.`);
  }

  // For find_references, we go straight to grep/rg since cross-file
  // analysis requires project-wide search — the structural parser is per-file.
  // But we enrich the results with classification (definition/import/usage).
  try {
    const result = grepReferences(symbol, scope, cwd, exact, log);

    if (result.error) {
      return errorResult(`find_references failed: ${result.error}. Use \`bash\` with \`grep -rn '${symbol}'\` as fallback.`);
    }

    if (result.references.length === 0) {
      return {
        content: [{ type: "text", text: `No references to "${symbol}" found in ${scope}` }],
        details: { result, fallback: true },
      };
    }

    // Cap results
    const refs = result.references.slice(0, MAX_REF_RESULTS);
    const truncated = result.references.length > MAX_REF_RESULTS;

    const text = formatReferences(symbol, refs, scope, truncated, result.references.length);

    log.info({ symbol, count: refs.length, truncated }, "find_references: complete");

    return {
      content: [{ type: "text", text }],
      details: { result: { ...result, references: refs }, fallback: true },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, symbol }, "find_references: failed");
    return errorResult(`find_references failed: ${msg}. Use \`bash\` with \`grep -rn '${symbol}'\` as fallback.`);
  }
}

// ── Directory walker (primary) ─────────────────────────────

function walkDir(
  absDir: string,
  relDir: string,
  depth: number,
  maxDepth: number,
  registry: LanguageRegistry,
  includeSummary: boolean,
  log: pino.Logger,
  onEntry: () => boolean, // returns true to stop
): MapEntry[] {
  if (depth >= maxDepth) return [];

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    log.warn({ dir: absDir, err }, "Cannot read directory");
    return [];
  }

  // Sort: dirs first, then files, alphabetically within each group
  dirEntries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const result: MapEntry[] = [];

  for (const entry of dirEntries) {
    if (entry.name.startsWith(".")) continue;
    if (onEntry()) break; // budget exceeded

    const relPath = path.join(relDir, entry.name);

    if (entry.isDirectory()) {
      if (registry.isIgnoredDir(entry.name)) continue;
      const children = walkDir(
        path.join(absDir, entry.name), relPath, depth + 1, maxDepth,
        registry, includeSummary, log, onEntry,
      );
      result.push({ path: relPath, type: "directory", children });
    } else if (entry.isFile()) {
      if (registry.isIgnoredFile(entry.name)) continue;

      let summary: string | undefined;
      if (includeSummary && registry.isCodeFile(entry.name)) {
        try {
          const content = fs.readFileSync(path.join(absDir, entry.name), "utf8");
          const s = getFileSummary(content, relPath, registry, log);
          if (s) summary = s;
        } catch {
          // Silently skip unreadable files
        }
      }

      result.push({ path: relPath, type: "file", summary });
    }
  }

  return result;
}

// ── Formatters ─────────────────────────────────────────────

function formatMapTree(entries: MapEntry[], indent: string): string {
  const lines: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const prefix = indent + (isLast ? "└── " : "├── ");
    const childIndent = indent + (isLast ? "    " : "│   ");
    const name = path.basename(entry.path);

    if (entry.type === "directory") {
      lines.push(`${prefix}${name}/`);
      if (entry.children && entry.children.length > 0) {
        lines.push(formatMapTree(entry.children, childIndent));
      }
    } else {
      const suffix = entry.summary ? ` — ${entry.summary}` : "";
      lines.push(`${prefix}${name}${suffix}`);
    }
  }

  return lines.join("\n");
}

function formatOutline(outline: FileOutline): string {
  const header = `${outline.path} (${outline.lines} lines) [${outline.language}]`;
  const sections: string[] = [header, ""];

  // Group entries by kind
  const imports = outline.entries.filter((e) => e.kind === "import");
  const reExports = outline.entries.filter((e) => e.kind === "re-export");
  const exported = outline.entries.filter((e) => e.exported && e.kind !== "import" && e.kind !== "re-export" && e.kind !== "export");
  const exportDefault = outline.entries.filter((e) => e.kind === "export");
  const nonExported = outline.entries.filter((e) => !e.exported && e.kind !== "import");

  if (imports.length > 0) {
    sections.push("Imports:");
    for (const e of imports) {
      sections.push(`  L${e.line}  ${e.name}${e.source ? ` from "${e.source}"` : ""}`);
    }
    sections.push("");
  }

  if (reExports.length > 0) {
    sections.push("Re-exports:");
    for (const e of reExports) {
      sections.push(`  L${e.line}  ${e.name}${e.source ? ` from "${e.source}"` : ""}`);
    }
    sections.push("");
  }

  if (exported.length > 0 || exportDefault.length > 0) {
    sections.push("Exported:");
    for (const e of [...exportDefault, ...exported]) {
      sections.push(formatEntry(e, "  "));
    }
    sections.push("");
  }

  if (nonExported.length > 0) {
    sections.push("Internal:");
    for (const e of nonExported) {
      sections.push(formatEntry(e, "  "));
    }
    sections.push("");
  }

  if (outline.warnings && outline.warnings.length > 0) {
    sections.push("Warnings:");
    for (const w of outline.warnings) {
      sections.push(`  ⚠ ${w}`);
    }
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

function formatEntry(entry: OutlineEntry, indent: string): string {
  const lineRef = entry.endLine ? `L${entry.line}-${entry.endLine}` : `L${entry.line}`;
  const defaultTag = entry.isDefault ? " (default)" : "";
  const sigTag = entry.signature ? ` ${entry.signature}` : "";

  let label: string;
  switch (entry.kind) {
    case "function":
      label = `function ${entry.name}${sigTag}`;
      break;
    case "class":
      label = `class ${entry.name}`;
      break;
    case "interface":
      label = `interface ${entry.name}`;
      break;
    case "type":
      label = `type ${entry.name}${sigTag}`;
      break;
    case "enum":
      label = `enum ${entry.name}`;
      break;
    case "namespace":
      label = `namespace ${entry.name}`;
      break;
    case "variable":
      label = entry.name;
      break;
    case "export":
      label = `default ${entry.name}`;
      break;
    default:
      label = `${entry.kind} ${entry.name}`;
  }

  let result = `${indent}${lineRef}  ${label}${defaultTag}`;

  // Children (class/interface members)
  if (entry.children && entry.children.length > 0) {
    const memberNames = entry.children.map((c) => {
      if (c.kind === "constructor") return "constructor()";
      if (c.kind === "method") return `${c.name}()`;
      if (c.kind === "getter") return `get ${c.name}`;
      if (c.kind === "setter") return `set ${c.name}`;
      return c.name;
    });
    result += ` { ${memberNames.join(", ")} }`;
  }

  return result;
}

function formatReferences(
  symbol: string,
  refs: Reference[],
  scope: string,
  truncated: boolean,
  totalCount: number,
): string {
  const header = `Symbol: "${symbol}" (${totalCount} reference${totalCount !== 1 ? "s" : ""} in ${scope})`;
  const sections: string[] = [header, ""];

  // Group by kind
  const definitions = refs.filter((r) => r.kind === "definition");
  const imports = refs.filter((r) => r.kind === "import");
  const exports = refs.filter((r) => r.kind === "export");
  const usages = refs.filter((r) => r.kind === "usage");

  if (definitions.length > 0) {
    sections.push("Definitions:");
    for (const r of definitions) {
      sections.push(`  ${r.file}:${r.line}`);
      sections.push(`    ${r.text}`);
    }
    sections.push("");
  }

  if (imports.length > 0) {
    sections.push("Imports:");
    for (const r of imports) {
      sections.push(`  ${r.file}:${r.line}`);
      sections.push(`    ${r.text}`);
    }
    sections.push("");
  }

  if (exports.length > 0) {
    sections.push("Exports:");
    for (const r of exports) {
      sections.push(`  ${r.file}:${r.line}`);
      sections.push(`    ${r.text}`);
    }
    sections.push("");
  }

  if (usages.length > 0) {
    sections.push("Usages:");
    for (const r of usages) {
      sections.push(`  ${r.file}:${r.line}`);
      sections.push(`    ${r.text}`);
    }
    sections.push("");
  }

  if (truncated) {
    sections.push(`(Showing ${refs.length} of ${totalCount} — use a narrower path to see all)`);
  }

  return sections.join("\n").trimEnd();
}

// ── Helpers ────────────────────────────────────────────────

function normalizePath(p: string): string {
  // Strip leading @ (some models include it)
  return p.startsWith("@") ? p.slice(1) : p;
}

function safeExists(absPath: string): boolean {
  try {
    fs.accessSync(absPath);
    return true;
  } catch {
    return false;
  }
}

function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { error: message },
  };
}
