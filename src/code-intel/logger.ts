/**
 * Pino-based logger for code-intel.
 *
 * Writes to stderr so tool results stay clean.
 * Keeps a ring buffer in memory for diagnostics / test assertions.
 */

import pino from "pino";

export interface BufferedLogEntry {
  level: number;
  time: number;
  msg: string;
  [key: string]: unknown;
}

// ── In-memory ring buffer ──────────────────────────────────

const buffer: BufferedLogEntry[] = [];
const MAX_BUFFER = 500;

function pushToBuffer(entry: BufferedLogEntry): void {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
}

/** Snapshot of the buffered log entries (for tests / diagnostics) */
export function getLogBuffer(): readonly BufferedLogEntry[] {
  return [...buffer];
}

/** Clear the ring buffer */
export function clearLogBuffer(): void {
  buffer.length = 0;
}

// ── Logger factory ─────────────────────────────────────────

export function createLogger(level: pino.Level = "info"): pino.Logger {
  return pino({
    name: "code-intel",
    level,
    transport: {
      target: "pino/file",
      options: { destination: 2 }, // stderr
    },
    hooks: {
      logMethod(inputArgs, method, lvl) {
        const entry: BufferedLogEntry = {
          level: lvl,
          time: Date.now(),
          msg: typeof inputArgs[0] === "string" ? inputArgs[0] : "",
        };
        if (typeof inputArgs[0] === "object" && inputArgs[0] !== null) {
          Object.assign(entry, inputArgs[0]);
          if (typeof inputArgs[1] === "string") entry.msg = inputArgs[1];
        }
        pushToBuffer(entry);
        method.apply(this, inputArgs as any);
      },
    },
  });
}

/** Shared singleton */
export const logger = createLogger("info");
