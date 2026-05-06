/**
 * Daemon lifecycle helpers — spawning, PID-file management, liveness checks.
 *
 * V0.3 design (KISS):
 *   - One daemon per user. PID at ~/.brikko/proxy.pid.
 *   - Spawned via `child_process.spawn(node, [cli.js, "proxy", "start", "--foreground", ...])`
 *     with `detached: true` and `stdio: "ignore"` so the parent shell can exit.
 *   - Liveness check: signal 0 to the PID. If the process exists, it's "alive".
 *   - Stop: SIGTERM, wait up to 5s, SIGKILL if it didn't exit.
 *
 * Cross-platform notes:
 *   - On Windows, `process.kill(pid, 0)` works (returns true if the process
 *     is alive), and SIGTERM is mapped to forceful TerminateProcess by Node.
 *     That's actually fine for us — the daemon doesn't have anything to
 *     gracefully flush beyond the log stream, and the log stream is auto-
 *     flushed on each line.
 *   - We don't try to reuse fork semantics or IPC — a plain spawned child
 *     reading argv is dead-simple to debug.
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { ensureBrikkoDir, proxyPidPath, proxyStatePath } from "../paths.js";
import { pathExists } from "../config.js";

export interface DaemonState {
  pid: number;
  port: number;
  apiBase: string;
  piiProtect: boolean;
  startedAt: number; // unix ms
  cliVersion: string;
}

/* ------------------------------------------------------------------------- */
/* PID file                                                                  */
/* ------------------------------------------------------------------------- */

/** Read the saved daemon state. Returns null if no PID file. */
export async function readState(): Promise<DaemonState | null> {
  const path = proxyStatePath();
  if (!(await pathExists(path))) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

/** Write the daemon state file (atomically-ish — single writeFile call). */
export async function writeState(state: DaemonState): Promise<void> {
  await ensureBrikkoDir();
  await writeFile(proxyStatePath(), JSON.stringify(state, null, 2), "utf8");
  await writeFile(proxyPidPath(), String(state.pid), "utf8");
}

/** Remove the PID + state files. Idempotent — missing files are fine. */
export async function clearState(): Promise<void> {
  for (const p of [proxyPidPath(), proxyStatePath()]) {
    try {
      await unlink(p);
    } catch {
      /* not present */
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Liveness                                                                  */
/* ------------------------------------------------------------------------- */

/** True if a process with this PID exists and is signal-able by us. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but not signal-able by us
    // (still alive, but we shouldn't claim ownership). Treat EPERM as
    // "alive but not ours" — caller must decide what to do.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read state, double-check the process is alive. If state exists but
 * process is gone (stale PID file from a crashed daemon), clean up and
 * return null.
 */
export async function readLiveState(): Promise<DaemonState | null> {
  const s = await readState();
  if (!s) return null;
  if (!isAlive(s.pid)) {
    await clearState();
    return null;
  }
  return s;
}

/* ------------------------------------------------------------------------- */
/* Spawn / kill                                                              */
/* ------------------------------------------------------------------------- */

export interface SpawnOptions {
  /** Path to dist/cli.js (the CLI entrypoint). */
  cliJs: string;
  port: number;
  apiBase: string;
  piiProtect: boolean;
}

/**
 * Spawn the daemon as a detached child. Returns the child's PID. Does NOT
 * wait for the daemon to start listening — caller should poll /healthz.
 *
 * The spawned process runs `brikko proxy start --foreground` so all the
 * actual server logic stays in one place (commands/proxy.ts).
 */
export function spawnDaemon(opts: SpawnOptions): number {
  const args = [
    opts.cliJs,
    "proxy",
    "start",
    "--foreground",
    "--port",
    String(opts.port),
    ...(opts.piiProtect ? [] : ["--no-pii-protect"]),
  ];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      BRIKKO_API_BASE: opts.apiBase,
    },
  });
  // unref so our parent (the user's shell) can exit immediately.
  child.unref();
  if (typeof child.pid !== "number") {
    throw new Error("Failed to spawn daemon — no PID returned");
  }
  return child.pid;
}

/**
 * Stop a daemon by PID: SIGTERM, wait up to `graceMs`, then SIGKILL.
 * Returns true if the process exited cleanly (or was already gone).
 */
export async function killDaemon(pid: number, graceMs = 5000): Promise<boolean> {
  if (!isAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
    return true;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  // Force-kill.
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone in the gap */
  }
  // Final check after a short beat.
  await sleep(200);
  return !isAlive(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------------- */
/* Health probe                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Poll http://127.0.0.1:<port>/healthz until it answers or `timeoutMs`
 * elapses. Returns the parsed JSON body on success, null on timeout.
 */
export async function waitForHealthz(
  port: number,
  timeoutMs = 10_000,
): Promise<unknown | null> {
  const url = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) return (await r.json()) as unknown;
    } catch {
      /* not ready yet */
    }
    await sleep(150);
  }
  return null;
}
