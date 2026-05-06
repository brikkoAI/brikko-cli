/**
 * Shared filesystem paths for the local proxy daemon (`brikko proxy *`).
 *
 * Layout under `~/.brikko/`:
 *
 *   ~/.brikko/
 *     config.json     ← API key (chmod 0600 on POSIX), see lib/auth.ts
 *     proxy.pid       ← PID of the running daemon (one process per user, V0.3)
 *     proxy.log       ← NDJSON log: { ts, level, event, ...fields } per line
 *     proxy.state.json← snapshot of port, pid, started_at, version
 *
 * Multi-port / multi-instance support is V0.4 — V0.3 assumes one daemon
 * per user, hence the unparameterised filenames. If a user runs `brikko
 * proxy start` while one is already alive, we fail loudly rather than
 * silently overwriting the PID file.
 *
 * On Windows the home dir comes from `os.homedir()` (typically
 * `C:\Users\<name>`), which lines up with how config.ts already stores
 * `~/.brikko/config.json`. Everything is created lazily — `brikkoDir()`
 * is just a path computation; `ensureBrikkoDir()` is what mutates the FS.
 */

import { mkdir, chmod } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

/** `~/.brikko/` — root for all CLI state. */
export function brikkoDir(): string {
  return join(homedir(), ".brikko");
}

/** PID file for the proxy daemon. */
export function proxyPidPath(): string {
  return join(brikkoDir(), "proxy.pid");
}

/** NDJSON request/response log for the proxy daemon. */
export function proxyLogPath(): string {
  return join(brikkoDir(), "proxy.log");
}

/** State snapshot (port, pid, started_at, version) — used by `proxy status`. */
export function proxyStatePath(): string {
  return join(brikkoDir(), "proxy.state.json");
}

/**
 * Ensure `~/.brikko/` exists with sane perms (0700 on POSIX so other
 * local users can't read the API key in `config.json`). Idempotent.
 */
export async function ensureBrikkoDir(): Promise<void> {
  const dir = brikkoDir();
  await mkdir(dir, { recursive: true });
  if (platform() !== "win32") {
    try {
      await chmod(dir, 0o700);
    } catch {
      // chmod can fail on FAT/network mounts — non-fatal, the file-level
      // 0600 on config.json is still our second line of defence.
    }
  }
}
