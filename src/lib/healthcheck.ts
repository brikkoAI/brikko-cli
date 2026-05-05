/**
 * HTTP healthcheck against Studio Core's auth endpoint.
 *
 * We use the built-in `fetch` (Node 18+) with AbortController — no extra deps.
 * Studio Core publishes /api/auth/status which returns 200 when the OAuth
 * client is ready, and 401/200 even before login (it's the canonical
 * "core is up" probe used by install.sh).
 */

import { setTimeout as sleep } from "node:timers/promises";

export interface HealthcheckOptions {
  /** Total time to wait, in ms. Default 60s. */
  timeoutMs?: number;
  /** Per-attempt connect timeout, in ms. Default 2s. */
  attemptTimeoutMs?: number;
  /** Interval between attempts, in ms. Default 2s. */
  intervalMs?: number;
  /** Optional progress callback (called once per failed attempt). */
  onAttempt?: (elapsedMs: number) => void;
}

/**
 * Single-shot probe. Returns true if the URL responds with any HTTP status
 * (we don't care about 2xx vs 4xx — both mean "core process is alive and
 * accepting connections", which is what we want).
 */
export async function probe(url: string, attemptTimeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
  try {
    await fetch(url, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Poll the URL until it responds or `timeoutMs` elapses.
 * Returns true on success, false on timeout. Never throws.
 */
export async function waitForHealthy(
  url: string,
  opts: HealthcheckOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 2000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await probe(url, attemptTimeoutMs)) return true;
    opts.onAttempt?.(Date.now() - start);
    await sleep(intervalMs);
  }
  return false;
}

/**
 * Build the Studio auth-status URL for a given port.
 * Uses 127.0.0.1 (not localhost) to dodge IPv6 first-attempt ::1 timeouts
 * common on Windows + WSL.
 */
export function studioAuthUrl(port: number): string {
  return `http://127.0.0.1:${port}/api/auth/status`;
}

/**
 * Check whether a TCP port is free on localhost. Uses Node's net module —
 * tries to bind, succeeds = port is free, EADDRINUSE = taken.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code !== "EADDRINUSE");
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
