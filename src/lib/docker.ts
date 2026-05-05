/**
 * Wrapper around `docker` and `docker compose` via execa.
 *
 * Design goals:
 *   - All commands return structured results (stdout/stderr/exitCode).
 *   - Errors carry actionable hints (Docker missing / daemon down /
 *     compose v2 missing). The thrown DockerError preserves the original
 *     execa error for advanced callers.
 *   - Tests mock execa via vi.mock("execa") and assert exact argv.
 */

import { execa, type ExecaError, type ResultPromise } from "execa";
import { setTimeout as sleep } from "node:timers/promises";

export type DockerErrorKind =
  | "docker-missing"
  | "compose-missing"
  | "daemon-down"
  | "exec-failed";

export class DockerError extends Error {
  override readonly name = "DockerError";
  readonly kind: DockerErrorKind;
  override readonly cause?: unknown;

  constructor(kind: DockerErrorKind, message: string, cause?: unknown) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
}

/** Result of a non-streaming docker compose call. */
export interface DockerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerOptions {
  /** cwd for the compose call (the install dir with docker-compose.yml). */
  cwd: string;
  /** Pipe child stdio to parent (true for `logs -f`); else capture. */
  inherit?: boolean;
  /** Extra env vars merged into process.env for this call. */
  env?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

/** True if `docker` binary is on PATH. */
export async function hasDocker(): Promise<boolean> {
  try {
    await execa("docker", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** True if `docker info` succeeds (i.e. daemon is reachable). */
export async function dockerDaemonAlive(): Promise<boolean> {
  try {
    await execa("docker", ["info"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** True if `docker compose version` works (Compose v2). */
export async function hasComposeV2(): Promise<boolean> {
  try {
    await execa("docker", ["compose", "version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Returns `docker --version` output, or null if docker is missing. */
export async function dockerVersion(): Promise<string | null> {
  try {
    const r = await execa("docker", ["--version"], { timeout: 5000 });
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/** Returns `docker compose version --short` output, or null. */
export async function composeVersion(): Promise<string | null> {
  try {
    const r = await execa("docker", ["compose", "version", "--short"], {
      timeout: 5000,
    });
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Wait for daemon to become alive, polling every `intervalMs`.
 * Returns true if daemon came up; false on timeout.
 * Useful right after Docker Desktop launch.
 */
export async function waitForDaemon(timeoutMs = 60_000, intervalMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await dockerDaemonAlive()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Compose execution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Run `docker compose <args>` in the given cwd. Returns captured output.
 * Throws DockerError on non-zero exit.
 */
export async function compose(args: string[], opts: DockerOptions): Promise<DockerResult> {
  try {
    const result = await execa("docker", ["compose", ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: opts.inherit ? "inherit" : "pipe",
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new DockerError(
        "exec-failed",
        `docker compose ${args.join(" ")} exited with code ${result.exitCode}`,
        result,
      );
    }
    return {
      exitCode: result.exitCode ?? 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
    };
  } catch (err) {
    if (err instanceof DockerError) throw err;
    const e = err as ExecaError;
    throw new DockerError(
      "exec-failed",
      `Failed to run docker compose ${args.join(" ")}: ${e.message ?? String(err)}`,
      err,
    );
  }
}

/**
 * Stream `docker compose <args>` to the parent stdio. Used for `logs -f` and
 * any long-running command where the user wants live output. Returns the
 * underlying ResultPromise so callers can attach signal handlers or await
 * completion.
 */
export function composeStream(args: string[], opts: DockerOptions): ResultPromise {
  return execa("docker", ["compose", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: "inherit",
    reject: false,
  });
}

/* -------------------------------------------------------------------------- */
/* Status helpers                                                              */
/* -------------------------------------------------------------------------- */

export interface ComposePsRow {
  name: string;
  service: string;
  state: string;
  status: string;
  health?: string;
  image?: string;
}

function rowFromObj(obj: Record<string, unknown>): ComposePsRow {
  return {
    name: String(obj["Name"] ?? ""),
    service: String(obj["Service"] ?? ""),
    state: String(obj["State"] ?? ""),
    status: String(obj["Status"] ?? ""),
    health: obj["Health"] ? String(obj["Health"]) : undefined,
    image: obj["Image"] ? String(obj["Image"]) : undefined,
  };
}

/**
 * Parse `docker compose ps --format json` output. Compose v2 emits one
 * JSON object per line (NDJSON) by default; older builds emit a single
 * JSON array. We handle both. Empty input → empty array.
 */
export function parseComposePs(stdout: string): ComposePsRow[] {
  // First try: parse the whole buffer as a JSON array (older compose).
  const trimmedAll = stdout.trim();
  if (trimmedAll.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmedAll) as Array<Record<string, unknown>>;
      if (Array.isArray(arr)) return arr.map(rowFromObj);
    } catch {
      /* fall through to NDJSON */
    }
  }

  // Default: NDJSON, one JSON object per line.
  const rows: ComposePsRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        rows.push(rowFromObj(parsed as Record<string, unknown>));
      }
    } catch {
      /* skip unparseable line */
    }
  }
  return rows;
}

/**
 * High-level: get current compose service state in `cwd`. Returns [] if
 * compose is not running or the project isn't initialized.
 */
export async function composePs(cwd: string): Promise<ComposePsRow[]> {
  try {
    const r = await compose(["ps", "--format", "json", "--all"], { cwd });
    return parseComposePs(r.stdout);
  } catch {
    return [];
  }
}
