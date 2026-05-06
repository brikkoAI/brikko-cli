/**
 * NDJSON logger for the proxy daemon.
 *
 * One JSON object per line, newline-terminated:
 *   {"ts":"2026-05-06T12:34:56.789Z","level":"info","event":"req",...}
 *
 * Why NDJSON not plain text: easy to grep+jq, easy to ship to ELK later,
 * survives multi-line content (event payloads often contain Unicode + newlines).
 *
 * Rotation is V0.4 — for V0.3 we just append. The file lives at
 * ~/.brikko/proxy.log, which is per-user; if it gets huge the user can
 * `truncate -s 0` it manually or `brikko proxy stop && rm proxy.log`.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { ensureBrikkoDir, proxyLogPath } from "../paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ProxyLogger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Flush buffered writes and close the file. */
  close(): Promise<void>;
}

export interface LoggerOptions {
  /** Also mirror to process.stderr (useful when --foreground). */
  mirrorToStderr?: boolean;
  /** Override file path (tests). */
  filePath?: string;
}

export async function createLogger(opts: LoggerOptions = {}): Promise<ProxyLogger> {
  await ensureBrikkoDir();
  const path = opts.filePath ?? proxyLogPath();
  const stream = createWriteStream(path, { flags: "a", encoding: "utf8" });

  const write = (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        ...fields,
      }) + "\n";
    stream.write(line);
    if (opts.mirrorToStderr) {
      process.stderr.write(line);
    }
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    close: () =>
      new Promise<void>((resolve) => {
        stream.end(resolve as () => void);
      }) as Promise<void>,
  };
}

/** No-op logger for tests / when logging is disabled. */
export function nullLogger(): ProxyLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    close: () => Promise.resolve(),
  };
}
