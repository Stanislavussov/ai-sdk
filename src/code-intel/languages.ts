/**
 * Language registry for code-intel.
 *
 * Ships with TypeScript / JavaScript / React support.
 * Extensible via config: `.pi/settings.json` → `codeIntel.languages`.
 *
 * Each LanguageConfig maps file extensions → a parser strategy.
 * The registry is a simple Map<extension, LanguageConfig> for O(1) lookups.
 */

import type { LanguageConfig, CodeIntelConfig } from "./types.js";

// ── Built-in language configs ──────────────────────────────

const TYPESCRIPT_CONFIG: LanguageConfig = {
  id: "typescript",
  name: "TypeScript",
  extensions: [".ts", ".mts", ".cts"],
  parser: "typescript",
  commentPrefix: "//",
};

const TYPESCRIPT_REACT_CONFIG: LanguageConfig = {
  id: "typescript-react",
  name: "TypeScript React",
  extensions: [".tsx"],
  parser: "typescript",
  commentPrefix: "//",
};

const JAVASCRIPT_CONFIG: LanguageConfig = {
  id: "javascript",
  name: "JavaScript",
  extensions: [".js", ".mjs", ".cjs"],
  parser: "typescript", // same parser — TS parser handles JS fine
  commentPrefix: "//",
};

const JAVASCRIPT_REACT_CONFIG: LanguageConfig = {
  id: "javascript-react",
  name: "JavaScript React",
  extensions: [".jsx"],
  parser: "typescript",
  commentPrefix: "//",
};

const BUILTIN_LANGUAGES: LanguageConfig[] = [
  TYPESCRIPT_CONFIG,
  TYPESCRIPT_REACT_CONFIG,
  JAVASCRIPT_CONFIG,
  JAVASCRIPT_REACT_CONFIG,
];

// ── Default ignore lists ───────────────────────────────────

export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vercel",
  ".cache",
  "coverage",
  "__pycache__",
  ".svelte-kit",
  ".expo",
  ".parcel-cache",
  "out",
  ".pi",
  ".agents",
]);

export const DEFAULT_IGNORE_EXTENSIONS = new Set([
  ".map",
  ".d.ts",       // declaration files can be noisy; include on demand
  ".min.js",
  ".bundle.js",
  ".lock",
  ".log",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2",
  ".pdf", ".doc", ".docx",
  ".exe", ".dll", ".so", ".dylib",
]);

// ── Registry ───────────────────────────────────────────────

export class LanguageRegistry {
  /** extension → config lookup (e.g. ".ts" → TypeScript) */
  private byExtension = new Map<string, LanguageConfig>();
  /** id → config lookup (e.g. "typescript" → config) */
  private byId = new Map<string, LanguageConfig>();

  private ignoreDirs: Set<string>;
  private ignoreExtensions: Set<string>;

  constructor(userConfig?: CodeIntelConfig) {
    this.ignoreDirs = new Set(DEFAULT_IGNORE_DIRS);
    this.ignoreExtensions = new Set(DEFAULT_IGNORE_EXTENSIONS);

    // Register built-ins first
    for (const lang of BUILTIN_LANGUAGES) {
      this.register(lang);
    }

    // Merge user config (overrides built-ins on same id)
    if (userConfig) {
      if (userConfig.languages) {
        for (const lang of userConfig.languages) {
          this.register(lang);
        }
      }
      if (userConfig.ignoreDirs) {
        for (const dir of userConfig.ignoreDirs) {
          this.ignoreDirs.add(dir);
        }
      }
      if (userConfig.ignoreExtensions) {
        for (const ext of userConfig.ignoreExtensions) {
          this.ignoreExtensions.add(ext);
        }
      }
    }
  }

  /** Register or override a language config */
  register(config: LanguageConfig): void {
    this.byId.set(config.id, config);
    for (const ext of config.extensions) {
      this.byExtension.set(ext.toLowerCase(), config);
    }
  }

  /** Resolve file path → LanguageConfig (or undefined if unknown) */
  resolve(filePath: string): LanguageConfig | undefined {
    const ext = extOf(filePath);
    // Check compound extensions first (e.g. ".d.ts", ".min.js")
    const compoundExt = compoundExtOf(filePath);
    if (compoundExt) {
      const compound = this.byExtension.get(compoundExt);
      if (compound) return compound;
    }
    return this.byExtension.get(ext);
  }

  /** Get config by language id */
  get(id: string): LanguageConfig | undefined {
    return this.byId.get(id);
  }

  /** All registered language configs */
  all(): LanguageConfig[] {
    return [...this.byId.values()];
  }

  /** All recognized file extensions */
  allExtensions(): string[] {
    return [...this.byExtension.keys()];
  }

  /** Should this directory be ignored in code_map traversal? */
  isIgnoredDir(name: string): boolean {
    return this.ignoreDirs.has(name);
  }

  /** Should this file be ignored based on extension? */
  isIgnoredFile(filePath: string): boolean {
    const ext = extOf(filePath);
    if (this.ignoreExtensions.has(ext)) return true;
    // Compound extension check
    const compound = compoundExtOf(filePath);
    if (compound && this.ignoreExtensions.has(compound)) return true;
    return false;
  }

  /** Is this a recognized (parseable) code file? */
  isCodeFile(filePath: string): boolean {
    return this.resolve(filePath) !== undefined;
  }
}

// ── Helpers ────────────────────────────────────────────────

function extOf(p: string): string {
  const basename = p.split("/").pop() ?? p;
  const i = basename.lastIndexOf(".");
  return i <= 0 ? "" : basename.slice(i).toLowerCase();
}

/** Extract compound extension like ".d.ts" or ".min.js" */
function compoundExtOf(p: string): string | undefined {
  const basename = p.split("/").pop() ?? p;
  // Look for patterns like foo.d.ts, foo.min.js, foo.test.ts
  const match = /\.([a-z]+\.[a-z]+)$/i.exec(basename);
  if (match) return `.${match[1].toLowerCase()}`;
  return undefined;
}
