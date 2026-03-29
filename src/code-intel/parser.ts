/**
 * Structural parser for TypeScript / JavaScript / React files.
 *
 * Uses the **TypeScript Compiler API** (`ts.createSourceFile`) — the same
 * parser that powers VSCode, tsc, and every major TS tool.  This gives us
 * correct, complete AST parsing for TS, JS, TSX, and JSX with zero custom
 * regex heuristics.
 *
 * Fallback: if the `typescript` module is unavailable at runtime (shouldn't
 * happen — it's a peerDependency), the tools layer falls back to grep.
 */

import type pino from "pino";
import type { EntryKind, FileOutline, LanguageConfig, OutlineEntry } from "./types.js";
import type { LanguageRegistry } from "./languages.js";

// ── Dynamic TS import (graceful fallback if missing) ───────

let ts: typeof import("typescript") | null = null;
try {
  ts = await import("typescript");
} catch {
  // Will be caught by callers — parseFile returns warnings
}

// ── Binary detection ───────────────────────────────────────

export function isBinaryContent(content: string, checkLength = 8192): boolean {
  const len = Math.min(content.length, checkLength);
  for (let i = 0; i < len; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

// ── Constants ──────────────────────────────────────────────

const MAX_FILE_SIZE = 2_097_152; // 2 MB

// ── Public API ─────────────────────────────────────────────

/**
 * Parse a file and return its structural outline.
 *
 * Routes to the TypeScript compiler for TS/JS/TSX/JSX.
 * For config-based regex languages, uses the generic regex path.
 * Always returns a result — never throws.
 */
export function parseFile(
  content: string,
  filePath: string,
  registry: LanguageRegistry,
  log?: pino.Logger,
): FileOutline {
  const langConfig = registry.resolve(filePath);
  const language = langConfig?.name ?? "unknown";

  const outline: FileOutline = {
    path: filePath,
    lines: content.split("\n").length,
    language,
    entries: [],
    warnings: [],
  };

  if (isBinaryContent(content)) {
    outline.warnings!.push("File appears to be binary — skipped parsing");
    return outline;
  }

  if (content.length > MAX_FILE_SIZE) {
    outline.warnings!.push(
      `File is ${(content.length / 1024).toFixed(0)} KB (limit ${MAX_FILE_SIZE / 1024} KB) — skipped`,
    );
    return outline;
  }

  if (!langConfig) {
    outline.warnings!.push("Unknown language — no structural parser available");
    return outline;
  }

  try {
    switch (langConfig.parser) {
      case "typescript":
        return parseWithTypeScript(content, filePath, language, log);
      case "regex":
        return parseWithRegex(content, filePath, language, langConfig, log);
      case "none":
        outline.warnings!.push(`Language "${language}" is configured with parser: "none"`);
        return outline;
      default:
        outline.warnings!.push(`Unknown parser type: "${langConfig.parser}"`);
        return outline;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.error({ err, filePath }, `Parser crashed on ${filePath}`);
    outline.warnings = outline.warnings ?? [];
    outline.warnings.push(`Parser error: ${msg}`);
    return outline;
  }
}

// ── TypeScript Compiler API parser ─────────────────────────

function parseWithTypeScript(
  content: string,
  filePath: string,
  language: string,
  log?: pino.Logger,
): FileOutline {
  if (!ts) {
    return {
      path: filePath,
      lines: content.split("\n").length,
      language,
      entries: [],
      warnings: ["TypeScript compiler not available — install `typescript` as a dependency"],
    };
  }

  const scriptKind = getScriptKind(filePath);
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind);

  const entries: OutlineEntry[] = [];
  const warnings: string[] = [];

  for (const statement of sourceFile.statements) {
    try {
      const result = visitStatement(statement, sourceFile);
      if (result) entries.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
      warnings.push(`Failed to parse statement at line ${line}: ${msg}`);
      log?.warn({ err, filePath, line }, "Statement parse error");
    }
  }

  return {
    path: filePath,
    lines: sourceFile.getLineAndCharacterOfPosition(content.length).line + 1,
    language,
    entries,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function getScriptKind(filePath: string): import("typescript").ScriptKind {
  if (!ts) return 0;
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function getLineNumber(node: import("typescript").Node, sf: import("typescript").SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function getEndLine(node: import("typescript").Node, sf: import("typescript").SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function hasModifier(node: import("typescript").Node, kind: import("typescript").SyntaxKind): boolean {
  if (!ts) return false;
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === kind) ?? false;
}

function isExported(node: import("typescript").Node): boolean {
  if (!ts) return false;
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isDefault(node: import("typescript").Node): boolean {
  if (!ts) return false;
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

// ── AST visitors ───────────────────────────────────────────

function visitStatement(
  node: import("typescript").Node,
  sf: import("typescript").SourceFile,
): OutlineEntry | null {
  if (!ts) return null;

  // Import declarations
  if (ts.isImportDeclaration(node)) {
    return visitImport(node, sf);
  }

  // Export declarations (re-exports)
  if (ts.isExportDeclaration(node)) {
    return visitExportDeclaration(node, sf);
  }

  // Export assignment: `export default X` or `export = X`
  if (ts.isExportAssignment(node)) {
    const expr = node.expression;
    const name = ts.isIdentifier(expr) ? expr.text : expr.getText(sf).slice(0, 60);
    return {
      kind: "export",
      name,
      line: getLineNumber(node, sf),
      exported: true,
      isDefault: !node.isExportEquals,
    };
  }

  // Function declarations
  if (ts.isFunctionDeclaration(node)) {
    const name = node.name?.text ?? "(anonymous)";
    return {
      kind: "function",
      name,
      line: getLineNumber(node, sf),
      endLine: getEndLine(node, sf),
      exported: isExported(node),
      isDefault: isDefault(node),
      signature: extractFunctionSignature(node, sf),
    };
  }

  // Class declarations
  if (ts.isClassDeclaration(node)) {
    const name = node.name?.text ?? "(anonymous)";
    const children = node.members.map((m) => visitClassMember(m, sf)).filter(Boolean) as OutlineEntry[];
    return {
      kind: "class",
      name,
      line: getLineNumber(node, sf),
      endLine: getEndLine(node, sf),
      exported: isExported(node),
      isDefault: isDefault(node),
      children: children.length > 0 ? children : undefined,
    };
  }

  // Interface declarations
  if (ts.isInterfaceDeclaration(node)) {
    const name = node.name.text;
    const children = node.members.map((m) => visitInterfaceMember(m, sf)).filter(Boolean) as OutlineEntry[];
    return {
      kind: "interface",
      name,
      line: getLineNumber(node, sf),
      endLine: getEndLine(node, sf),
      exported: isExported(node),
      children: children.length > 0 ? children : undefined,
    };
  }

  // Type alias declarations
  if (ts.isTypeAliasDeclaration(node)) {
    const name = node.name.text;
    let sig: string | undefined;
    const typeText = node.type.getText(sf);
    if (typeText.length <= 80) {
      sig = typeText;
    } else {
      sig = typeText.slice(0, 77) + "...";
    }
    return {
      kind: "type",
      name,
      line: getLineNumber(node, sf),
      endLine: getEndLine(node, sf),
      exported: isExported(node),
      signature: sig,
    };
  }

  // Enum declarations
  if (ts.isEnumDeclaration(node)) {
    return {
      kind: "enum",
      name: node.name.text,
      line: getLineNumber(node, sf),
      endLine: getEndLine(node, sf),
      exported: isExported(node),
    };
  }

  // Variable statements (const/let/var)
  if (ts.isVariableStatement(node)) {
    const exported_ = isExported(node);
    // Take the first declaration's name (handles `const { a, b } = ...` loosely)
    const decl = node.declarationList.declarations[0];
    if (decl) {
      const name = decl.name.getText(sf);
      return {
        kind: "variable",
        name,
        line: getLineNumber(node, sf),
        exported: exported_,
      };
    }
  }

  // Module/namespace declarations
  if (ts.isModuleDeclaration(node)) {
    return {
      kind: "namespace",
      name: node.name.text,
      line: getLineNumber(node, sf),
      endLine: getEndLine(node, sf),
      exported: isExported(node),
    };
  }

  return null;
}

// ── Import visitor ─────────────────────────────────────────

function visitImport(
  node: import("typescript").ImportDeclaration,
  sf: import("typescript").SourceFile,
): OutlineEntry {
  if (!ts) return { kind: "import", name: "", line: 1, exported: false };

  const moduleSpec = (node.moduleSpecifier as import("typescript").StringLiteral).text;
  const names: string[] = [];

  if (node.importClause) {
    // Default import: `import Foo from "..."`
    if (node.importClause.name) {
      names.push(node.importClause.name.text);
    }

    const bindings = node.importClause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        // `import * as ns from "..."`
        names.push(bindings.name.text);
      } else if (ts.isNamedImports(bindings)) {
        // `import { A, B as C } from "..."`
        for (const spec of bindings.elements) {
          if (spec.propertyName) {
            names.push(`${spec.propertyName.text} as ${spec.name.text}`);
          } else {
            names.push(spec.name.text);
          }
        }
      }
    }
  }

  return {
    kind: "import",
    name: names.length > 0 ? names.join(", ") : moduleSpec,
    line: getLineNumber(node, sf),
    exported: false,
    source: moduleSpec,
  };
}

// ── Export declaration visitor (re-exports) ─────────────────

function visitExportDeclaration(
  node: import("typescript").ExportDeclaration,
  sf: import("typescript").SourceFile,
): OutlineEntry {
  if (!ts) return { kind: "re-export", name: "", line: 1, exported: true };

  const source = node.moduleSpecifier
    ? (node.moduleSpecifier as import("typescript").StringLiteral).text
    : undefined;

  if (!node.exportClause) {
    // `export * from "..."`
    return {
      kind: "re-export",
      name: "*",
      line: getLineNumber(node, sf),
      exported: true,
      source,
    };
  }

  if (ts.isNamespaceExport(node.exportClause)) {
    // `export * as Ns from "..."`
    return {
      kind: "re-export",
      name: `* as ${node.exportClause.name.text}`,
      line: getLineNumber(node, sf),
      exported: true,
      source,
    };
  }

  // `export { A, B } from "..."`
  const names = node.exportClause.elements.map((spec) => {
    if (spec.propertyName) {
      return `${spec.propertyName.text} as ${spec.name.text}`;
    }
    return spec.name.text;
  });

  return {
    kind: "re-export",
    name: names.join(", "),
    line: getLineNumber(node, sf),
    exported: true,
    source,
  };
}

// ── Class member visitor ───────────────────────────────────

function visitClassMember(
  member: import("typescript").ClassElement,
  sf: import("typescript").SourceFile,
): OutlineEntry | null {
  if (!ts) return null;

  if (ts.isConstructorDeclaration(member)) {
    return { kind: "constructor", name: "constructor", line: getLineNumber(member, sf), exported: false };
  }

  if (ts.isMethodDeclaration(member)) {
    const name = member.name.getText(sf);
    return { kind: "method", name, line: getLineNumber(member, sf), exported: false };
  }

  if (ts.isPropertyDeclaration(member)) {
    const name = member.name.getText(sf);
    return { kind: "property", name, line: getLineNumber(member, sf), exported: false };
  }

  if (ts.isGetAccessorDeclaration(member)) {
    const name = member.name.getText(sf);
    return { kind: "getter", name, line: getLineNumber(member, sf), exported: false };
  }

  if (ts.isSetAccessorDeclaration(member)) {
    const name = member.name.getText(sf);
    return { kind: "setter", name, line: getLineNumber(member, sf), exported: false };
  }

  return null;
}

// ── Interface member visitor ───────────────────────────────

function visitInterfaceMember(
  member: import("typescript").TypeElement,
  sf: import("typescript").SourceFile,
): OutlineEntry | null {
  if (!ts) return null;

  if (ts.isPropertySignature(member)) {
    const name = member.name.getText(sf);
    return { kind: "property", name, line: getLineNumber(member, sf), exported: false };
  }

  if (ts.isMethodSignature(member)) {
    const name = member.name.getText(sf);
    return { kind: "method", name, line: getLineNumber(member, sf), exported: false };
  }

  // Index signatures, call signatures, construct signatures — skip
  return null;
}

// ── Function signature extraction ──────────────────────────

function extractFunctionSignature(
  node: import("typescript").FunctionDeclaration,
  sf: import("typescript").SourceFile,
): string | undefined {
  if (!ts) return undefined;

  const params = node.parameters.map((p) => p.getText(sf)).join(", ");
  const ret = node.type ? node.type.getText(sf) : undefined;

  if (params.length > 80) {
    return ret ? `(...) → ${ret}` : "(...)";
  }
  return ret ? `(${params}) → ${ret}` : `(${params})`;
}

// ── Generic regex parser (for config-based languages) ──────

function parseWithRegex(
  content: string,
  filePath: string,
  language: string,
  config: LanguageConfig,
  log?: pino.Logger,
): FileOutline {
  const lines = content.split("\n");
  const outline: FileOutline = {
    path: filePath,
    lines: lines.length,
    language,
    entries: [],
    warnings: [],
  };

  const patterns = config.patterns;
  if (!patterns || Object.keys(patterns).length === 0) {
    outline.warnings!.push(`No regex patterns defined for language "${language}"`);
    return outline;
  }

  const compiled: Array<{ kind: EntryKind; re: RegExp }> = [];
  for (const [kindStr, pattern] of Object.entries(patterns)) {
    try {
      compiled.push({ kind: kindStr as EntryKind, re: new RegExp(pattern) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn({ pattern, kind: kindStr }, `Invalid regex pattern: ${msg}`);
      outline.warnings!.push(`Invalid pattern for "${kindStr}": ${msg}`);
    }
  }

  const commentPrefix = config.commentPrefix ?? "//";

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.trimStart();
    if (stripped.startsWith(commentPrefix)) continue;

    for (const { kind, re } of compiled) {
      const m = re.exec(stripped);
      if (m) {
        const name = m.groups?.["name"] ?? m[1] ?? stripped.slice(0, 60);
        outline.entries.push({ kind, name: name.trim(), line: i + 1, exported: false });
        break;
      }
    }
  }

  outline.warnings = outline.warnings!.length > 0 ? outline.warnings : undefined;
  return outline;
}

// ── Summary (for code_map) ─────────────────────────────────

/**
 * One-line summary of a file's public surface area.
 */
export function getFileSummary(
  content: string,
  filePath: string,
  registry: LanguageRegistry,
  log?: pino.Logger,
): string {
  try {
    const outline = parseFile(content, filePath, registry, log);
    if (outline.entries.length === 0) return "";

    const exported = outline.entries.filter((e) => e.exported && e.kind !== "import");
    const targets = exported.length > 0 ? exported : outline.entries.filter((e) => e.kind !== "import");
    if (targets.length === 0) return "";

    const parts: string[] = [];
    for (const entry of targets.slice(0, 6)) {
      switch (entry.kind) {
        case "function": parts.push(`${entry.name}()`); break;
        case "class": parts.push(`class ${entry.name}`); break;
        case "interface": parts.push(`interface ${entry.name}`); break;
        case "type": parts.push(`type ${entry.name}`); break;
        case "enum": parts.push(`enum ${entry.name}`); break;
        case "namespace": parts.push(`namespace ${entry.name}`); break;
        case "re-export": parts.push(`re-exports from ${entry.source ?? "?"}`); break;
        case "variable": parts.push(entry.name); break;
        default: parts.push(entry.name);
      }
    }
    if (targets.length > 6) parts.push(`+${targets.length - 6} more`);

    return `${exported.length > 0 ? "Exports" : "Contains"}: ${parts.join(", ")}`;
  } catch (err) {
    log?.warn({ err, filePath }, "Summary extraction failed");
    return "";
  }
}
