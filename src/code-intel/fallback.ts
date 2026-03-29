/**
 * Grep/rg-based fallback for when the structural parser fails or
 * the file language is unsupported.
 *
 * Every function here catches its own errors and returns something useful
 * (even if it's just an error message).  The caller never needs to
 * try/catch these.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type pino from "pino";
import type { CodeMap, FileOutline, MapEntry, Reference, ReferenceKind, ReferenceResult } from "./types.js";
import { log as sdkLog } from "../arch-agents/logger.js";

// ── Tool detection ─────────────────────────────────────────

let _hasRg: boolean | null = null;

export function hasRipgrep(): boolean {
  if (_hasRg !== null) return _hasRg;
  try {
    execSync("rg --version", { stdio: "ignore", timeout: 3000 });
    _hasRg = true;
  } catch {
    _hasRg = false;
  }
  return _hasRg;
}

/** Reset cached detection (for tests) */
export function resetToolCache(): void {
  _hasRg = null;
}

// ── Fallback: code_outline via grep ────────────────────────

/**
 * Grep-based outline: find lines that look like declarations.
 * Much less structured than the parser but always works.
 */
export function grepOutline(filePath: string, cwd: string, log?: pino.Logger): FileOutline {
  sdkLog.info("FALLBACK", `grepOutline called`, { filePath });
  const absPath = path.resolve(cwd, filePath);
  const outline: FileOutline = {
    path: filePath,
    lines: 0,
    language: "unknown",
    entries: [],
    fallback: true,
    warnings: [],
  };

  try {
    if (!fs.existsSync(absPath)) {
      outline.warnings!.push(`File not found: ${absPath}`);
      return outline;
    }

    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      outline.warnings!.push(`Path is a directory, not a file: ${absPath}`);
      return outline;
    }

    const content = fs.readFileSync(absPath, "utf8");
    const lines = content.split("\n");
    outline.lines = lines.length;

    // Pattern matches common TS/JS declaration keywords
    const pattern = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|namespace|import|export)\s/;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (pattern.test(trimmed)) {
        // Determine kind loosely
        const kind = inferKindFromLine(trimmed);
        const name = extractNameFromLine(trimmed);
        const exported = trimmed.startsWith("export");
        outline.entries.push({
          kind,
          name: name || trimmed.slice(0, 80),
          line: i + 1,
          exported,
        });
      }
    }

    log?.info({ filePath, entryCount: outline.entries.length }, "Grep fallback outline");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error({ err, filePath }, "Grep outline failed");
    outline.warnings!.push(`Grep fallback error: ${msg}`);
  }

  outline.warnings = outline.warnings!.length > 0 ? outline.warnings : undefined;
  return outline;
}

// ── Fallback: code_map via find + ls ───────────────────────

/**
 * Simple directory listing via fs.readdirSync.
 * No summaries — just the tree structure.
 */
export function fallbackCodeMap(
  dirPath: string,
  cwd: string,
  maxDepth: number,
  ignoreDirs: Set<string>,
  log?: pino.Logger,
): CodeMap {
  sdkLog.info("FALLBACK", `fallbackCodeMap called`, { dirPath, maxDepth, ignoreDirs: [...ignoreDirs] });
  const absPath = path.resolve(cwd, dirPath);
  const result: CodeMap = {
    root: dirPath,
    entries: [],
    fallback: true,
  };

  try {
    if (!fs.existsSync(absPath)) {
      result.error = `Directory not found: ${absPath}`;
      return result;
    }

    result.entries = walkFallback(absPath, dirPath, 0, maxDepth, ignoreDirs, log);
    log?.info({ dirPath, entryCount: result.entries.length }, "Fallback code_map");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error({ err, dirPath }, "Fallback code_map failed");
    result.error = msg;
  }

  return result;
}

function walkFallback(
  absDir: string,
  relDir: string,
  depth: number,
  maxDepth: number,
  ignoreDirs: Set<string>,
  log?: pino.Logger,
): MapEntry[] {
  if (depth >= maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (err) {
    log?.warn({ dir: absDir, err }, "Cannot read directory");
    return [];
  }

  const result: MapEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const relPath = path.join(relDir, entry.name);

    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      const children = walkFallback(
        path.join(absDir, entry.name), relPath, depth + 1, maxDepth, ignoreDirs, log,
      );
      result.push({ path: relPath, type: "directory", children });
    } else if (entry.isFile()) {
      result.push({ path: relPath, type: "file" });
    }
  }

  return result;
}

// ── Fallback: find_references via grep/rg ──────────────────

const MAX_GREP_RESULTS = 200;

/**
 * Search for symbol references using rg (preferred) or grep.
 */
export function grepReferences(
  symbol: string,
  scope: string,
  cwd: string,
  exact: boolean,
  log?: pino.Logger,
): ReferenceResult {
  sdkLog.info("FALLBACK", `grepReferences called`, { symbol, scope, exact, hasRg: hasRipgrep() });

  const result: ReferenceResult = {
    symbol,
    references: [],
    fallback: true,
  };

  const absScope = path.resolve(cwd, scope);
  if (!fs.existsSync(absScope)) {
    result.error = `Path not found: ${absScope}`;
    return result;
  }

  try {
    // Escape regex special chars in the symbol name
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = exact ? `\\b${escaped}\\b` : escaped;

    let output: string;
    if (hasRipgrep()) {
      const cmd = [
        "rg", "--no-heading", "--line-number", "--no-ignore",
        "--max-count", String(MAX_GREP_RESULTS),
        "--type", "ts", "--type", "js",
        "-e", JSON.stringify(pattern), // quote the pattern safely
        JSON.stringify(absScope),
      ].join(" ");
      sdkLog.debug("FALLBACK", `Running ripgrep command`, { cmd });
      output = safeExec(cmd, cwd, log);
    } else {
      // GNU grep fallback
      const includeFlags = "--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.mts' --include='*.cts' --include='*.mjs' --include='*.cjs'";
      const cmd = `grep -rn ${includeFlags} -E ${JSON.stringify(pattern)} ${JSON.stringify(absScope)} | head -${MAX_GREP_RESULTS}`;
      sdkLog.debug("FALLBACK", `Running grep command`, { cmd });
      output = safeExec(cmd, cwd, log);
    }

    if (!output.trim()) {
      log?.info({ symbol, scope }, "No references found");
      return result;
    }

    // Parse grep/rg output: "file:line:text"
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const match = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!match) continue;

      const file = path.relative(cwd, match[1]);
      const lineNum = parseInt(match[2], 10);
      const text = match[3].trim();
      const kind = classifyReference(text, symbol);

      result.references.push({ file, line: lineNum, text, kind });
    }

    log?.info({ symbol, count: result.references.length }, "Grep references found");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error({ err, symbol }, "Grep references failed");
    result.error = msg;
  }

  return result;
}

// ── Shared helpers ─────────────────────────────────────────

function safeExec(cmd: string, cwd: string, log?: pino.Logger): string {
  sdkLog.debug("FALLBACK", `safeExec: executing`, { cmd: cmd.slice(0, 300), cwd });
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = output.split("\n").filter(Boolean).length;
    sdkLog.debug("FALLBACK", `safeExec: success`, { outputLines: lines, outputLength: output.length });
    return output;
  } catch (err: any) {
    // grep returns exit code 1 when no matches — that's not an error
    if (err.status === 1 && (err.stdout || err.stdout === "")) {
      sdkLog.debug("FALLBACK", `safeExec: no matches (exit code 1)`, { cmd: cmd.slice(0, 200) });
      return err.stdout ?? "";
    }
    sdkLog.warn("FALLBACK", `safeExec: command failed`, { cmd: cmd.slice(0, 200), error: err.message, exitCode: err.status });
    log?.warn({ cmd, err: err.message }, "Shell command failed");
    return "";
  }
}

function classifyReference(lineText: string, symbol: string): ReferenceKind {
  const trimmed = lineText.trim();

  // Import line
  if (/^import\s/.test(trimmed)) return "import";

  // Export line (re-export or export declaration)
  if (/^export\s/.test(trimmed)) {
    // Is it a re-export or export-from?
    if (trimmed.includes(" from ")) return "export";
    // Is it defining the symbol?
    const defPattern = new RegExp(
      `^export\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var|namespace)\\s+${escapeRegex(symbol)}\\b`,
    );
    if (defPattern.test(trimmed)) return "definition";
    return "export";
  }

  // Definition: standalone declaration
  const defPattern = new RegExp(
    `^(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var|namespace)\\s+${escapeRegex(symbol)}\\b`,
  );
  if (defPattern.test(trimmed)) return "definition";

  return "usage";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferKindFromLine(line: string): "import" | "export" | "function" | "class" | "interface" | "type" | "enum" | "variable" | "namespace" {
  if (/\bimport\s/.test(line)) return "import";
  if (/\bfunction\b/.test(line)) return "function";
  if (/\bclass\b/.test(line)) return "class";
  if (/\binterface\b/.test(line)) return "interface";
  if (/\btype\s+\w+\s*[<=]/.test(line)) return "type";
  if (/\benum\b/.test(line)) return "enum";
  if (/\bnamespace\b/.test(line)) return "namespace";
  if (/\b(?:const|let|var)\b/.test(line)) return "variable";
  return "export";
}

function extractNameFromLine(line: string): string | null {
  // Try to get the identifier after the declaration keyword
  const m = /(?:function\*?|class|interface|type|enum|const|let|var|namespace)\s+(\w+)/.exec(line);
  return m ? m[1] : null;
}
