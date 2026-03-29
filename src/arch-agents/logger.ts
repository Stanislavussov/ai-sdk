import fs from "node:fs";
import path from "node:path";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_COLORS: Record<LogLevel, string> = {
  DEBUG: "\x1b[36m",  // cyan
  INFO:  "\x1b[32m",  // green
  WARN:  "\x1b[33m",  // yellow
  ERROR: "\x1b[31m",  // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

let logFilePath: string | null = null;
let enableConsole = false;

/**
 * Initialize the logger. Call once at startup.
 * @param cwd — project root; log file goes to `.pi/ai-sdk-debug.log`
 * @param console — also print to stdout (default: false)
 */
export function initLogger(cwd: string, console_: boolean = false): void {
  const dir = path.resolve(cwd, ".pi");
  fs.mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, "ai-sdk-debug.log");
  enableConsole = console_;

  // Truncate on init so each session starts fresh
  fs.writeFileSync(logFilePath, `=== ai-sdk debug log — ${new Date().toISOString()} ===\n\n`);
}

function write(level: LogLevel, tag: string, message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const dataStr = data ? `  ${JSON.stringify(data, null, 2).replace(/\n/g, "\n         ")}` : "";
  const line = `[${ts}] ${level.padEnd(5)} [${tag}] ${message}${dataStr}\n`;

  if (logFilePath) {
    try { fs.appendFileSync(logFilePath, line); } catch { /* ignore */ }
  }

  if (enableConsole) {
    const color = LOG_COLORS[level];
    const consoleLine = `${DIM}[${ts}]${RESET} ${color}${level.padEnd(5)}${RESET} [${tag}] ${message}${dataStr}`;
    console.log(consoleLine);
  }
}

// ── Public API ────────────────────────────────────────────

export const log = {
  debug: (tag: string, msg: string, data?: Record<string, unknown>) => write("DEBUG", tag, msg, data),
  info:  (tag: string, msg: string, data?: Record<string, unknown>) => write("INFO",  tag, msg, data),
  warn:  (tag: string, msg: string, data?: Record<string, unknown>) => write("WARN",  tag, msg, data),
  error: (tag: string, msg: string, data?: Record<string, unknown>) => write("ERROR", tag, msg, data),
};
