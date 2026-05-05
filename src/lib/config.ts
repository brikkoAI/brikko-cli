/**
 * Read/write Brikko Studio's .env file (KEY=VALUE format).
 *
 * Deliberately tiny — no dotenv dep. Compose interpolates ${KEY:-default}
 * itself; we only need to round-trip what `brikko init` and `brikko update`
 * touch (BRIKKO_PORT, BRIKKO_VERSION, etc).
 *
 * Quoting rules:
 *   - Values with spaces / shell metachars get double-quoted on write.
 *   - We never preserve user comments perfectly — we read+merge+rewrite.
 *     If users want exotic .env layouts they should hand-edit and skip
 *     `brikko init`.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default install dir matches install.sh: $HOME/brikko-studio */
export const DEFAULT_INSTALL_DIR: string = join(homedir(), "brikko-studio");

/** Default Studio UI port. Same as install.sh + docker-compose.yml fallback. */
export const DEFAULT_PORT = 3737;

/** Default image tag. Compose treats "latest" as the floating tip. */
export const DEFAULT_VERSION = "latest";

export type EnvMap = Record<string, string>;

/* -------------------------------------------------------------------------- */
/* Parse / serialize                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Parse a .env file body. Supports:
 *   - Comments (# at start of line)
 *   - KEY=VALUE
 *   - KEY="VALUE with spaces"
 *   - KEY='single quoted'
 * Ignores malformed lines silently.
 */
export function parseEnv(content: string): EnvMap {
  const result: EnvMap = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (matching pair only).
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      if (value.length >= 2) value = value.slice(1, -1);
    }

    // Validate key: must be a shell-safe identifier.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    result[key] = value;
  }
  return result;
}

/**
 * Serialize an EnvMap back to .env text. Keys emitted in insertion order.
 * Values containing spaces, '#', '=', or quotes get double-quoted with
 * inner double-quotes backslash-escaped.
 */
export function serializeEnv(env: EnvMap): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${quoteIfNeeded(value)}`);
  }
  return lines.join("\n") + "\n";
}

function quoteIfNeeded(value: string): string {
  if (value === "") return "";
  if (/^[A-Za-z0-9_./:@\-+]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/* -------------------------------------------------------------------------- */
/* File I/O                                                                    */
/* -------------------------------------------------------------------------- */

export interface BrikkoEnv {
  port: number;
  version: string;
  gateway: string;
  /** Raw KV map — use this for fields outside the curated set. */
  raw: EnvMap;
}

const ENV_DEFAULTS: EnvMap = {
  BRIKKO_GATEWAY: "https://api.brikko.ru",
  BRIKKO_PORT: String(DEFAULT_PORT),
  BRIKKO_USE_INMEM_KEYCHAIN: "0",
  ANONYMIZER_PORT: "8403",
  REDIS_PORT: "6379",
  BRIKKO_VERSION: DEFAULT_VERSION,
};

/** Path to .env in a Brikko Studio install dir. */
export function envPath(installDir: string): string {
  return join(installDir, ".env");
}

/** Path to docker-compose.yml in a Brikko Studio install dir. */
export function composePath(installDir: string): string {
  return join(installDir, "docker-compose.yml");
}

/** Returns true if `path` exists (file or dir). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read .env from `installDir`. If missing, returns defaults — caller decides
 * whether that's an error (e.g. `brikko start` without prior `brikko init`).
 */
export async function readBrikkoEnv(installDir: string): Promise<BrikkoEnv> {
  const path = envPath(installDir);
  let raw: EnvMap = { ...ENV_DEFAULTS };
  if (await pathExists(path)) {
    const content = await readFile(path, "utf8");
    raw = { ...ENV_DEFAULTS, ...parseEnv(content) };
  }
  const portRaw = raw["BRIKKO_PORT"] ?? String(DEFAULT_PORT);
  const portNum = Number.parseInt(portRaw, 10);
  return {
    port: Number.isFinite(portNum) && portNum > 0 ? portNum : DEFAULT_PORT,
    version: raw["BRIKKO_VERSION"] ?? DEFAULT_VERSION,
    gateway: raw["BRIKKO_GATEWAY"] ?? "https://api.brikko.ru",
    raw,
  };
}

/**
 * Atomic-ish write of .env (write to tmp, rename). Preserves any extra keys
 * present in `extraRaw` that aren't in the curated set.
 */
export async function writeBrikkoEnv(
  installDir: string,
  patch: Partial<{ port: number; version: string; gateway: string }>,
  extraRaw: EnvMap = {},
): Promise<void> {
  const merged: EnvMap = { ...ENV_DEFAULTS, ...extraRaw };
  if (patch.port !== undefined) merged["BRIKKO_PORT"] = String(patch.port);
  if (patch.version !== undefined) merged["BRIKKO_VERSION"] = patch.version;
  if (patch.gateway !== undefined) merged["BRIKKO_GATEWAY"] = patch.gateway;

  const body = serializeEnv(merged);
  await writeFile(envPath(installDir), body, "utf8");
}

/** Validate a port number — must be 1..65535 and not in the reserved system range. */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
