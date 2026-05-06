/**
 * User-level config for `brikko-cli` API commands (chat / anonymize / restore /
 * safe-chat). Stored at `~/.brikko/config.json`, separately from Studio's
 * install-dir `.env` — those are different concerns:
 *
 *   ~/.brikko/config.json   ← THIS file: API key + override base URL.
 *   $HOME/brikko-studio/.env ← compose env: ports, image tags, gateway URL.
 *
 * Resolution order (first hit wins):
 *   1. explicit `--key` flag
 *   2. BRIKKO_API_KEY env var
 *   3. ~/.brikko/config.json
 *   4. interactive prompt (only if process.stdin is a TTY) — saves to file.
 *
 * On POSIX we chmod 0600 to keep the key out of `cat ~/.brikko/config.json`
 * by another user. On Windows the FS ACL inherits the user profile, which
 * is the expected protection model there.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import prompts from "prompts";
import { pathExists } from "./config.js";
import { log } from "./logger.js";

export interface BrikkoUserConfig {
  apiKey?: string;
  apiBase?: string;
}

export const DEFAULT_API_BASE = "https://api.brikko.ru";

/** Path to user-level config file. */
export function userConfigPath(): string {
  return join(homedir(), ".brikko", "config.json");
}

/** Read ~/.brikko/config.json. Missing/corrupt → empty config. */
export async function readUserConfig(): Promise<BrikkoUserConfig> {
  const path = userConfigPath();
  if (!(await pathExists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const obj = parsed as Record<string, unknown>;
    const cfg: BrikkoUserConfig = {};
    if (typeof obj["apiKey"] === "string") cfg.apiKey = obj["apiKey"];
    if (typeof obj["apiBase"] === "string") cfg.apiBase = obj["apiBase"];
    return cfg;
  } catch {
    // Don't fail commands over a corrupt config — treat as empty.
    return {};
  }
}

/** Write ~/.brikko/config.json atomically-ish + chmod 0600 on POSIX. */
export async function writeUserConfig(cfg: BrikkoUserConfig): Promise<void> {
  const path = userConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  if (platform() !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod can fail on some FS (FAT, network mounts) — non-fatal.
    }
  }
}

/** Sanity check on key shape. We accept `sk-brk-…` and a generic `sk-…` for forward-compat. */
export function looksLikeApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9_\-]{8,}$/.test(value.trim());
}

export interface ResolveAuthOptions {
  /** From command-line `--key` flag. */
  key?: string | undefined;
  /** Allow interactive prompt if no key found. */
  interactive?: boolean;
}

export interface ResolvedAuth {
  apiKey: string;
  apiBase: string;
  /** Where the key came from — for diagnostics. */
  source: "flag" | "env" | "file" | "prompt";
}

/**
 * Resolve API key + base URL from flag/env/file, optionally prompting the user.
 * Saves a freshly-prompted key to ~/.brikko/config.json so subsequent commands
 * are non-interactive. Throws a tagged Error if no key can be obtained.
 */
export async function resolveAuth(opts: ResolveAuthOptions = {}): Promise<ResolvedAuth> {
  const cfg = await readUserConfig();
  const apiBase =
    process.env["BRIKKO_API_BASE"]?.trim() ||
    cfg.apiBase?.trim() ||
    // Backwards-compat with Studio's BRIKKO_GATEWAY name. Same URL today.
    process.env["BRIKKO_GATEWAY"]?.trim() ||
    DEFAULT_API_BASE;

  // 1. flag
  if (opts.key && opts.key.trim()) {
    return { apiKey: opts.key.trim(), apiBase, source: "flag" };
  }
  // 2. env
  const envKey = process.env["BRIKKO_API_KEY"]?.trim();
  if (envKey) return { apiKey: envKey, apiBase, source: "env" };
  // 3. file
  if (cfg.apiKey?.trim()) return { apiKey: cfg.apiKey.trim(), apiBase, source: "file" };
  // 4. prompt (only if stdin is a TTY — never block in pipelines / CI)
  if (opts.interactive && process.stdin.isTTY) {
    log.info("API ключ не найден. Получи его на https://brikko.ru/app/keys");
    const answers = await prompts(
      {
        type: "password",
        name: "apiKey",
        message: "Вставь API ключ (sk-brk-…)",
        validate: (v: string) =>
          looksLikeApiKey(v) || "Похоже не на ключ Brikko. Формат: sk-brk-…",
      },
      { onCancel: () => process.exit(2) },
    );
    const apiKey = (answers["apiKey"] as string | undefined)?.trim();
    if (!apiKey) {
      throw new AuthError("Прерывание — ключ не введён.");
    }
    await writeUserConfig({ ...cfg, apiKey });
    log.ok(`Ключ сохранён в ${userConfigPath()}`);
    return { apiKey, apiBase, source: "prompt" };
  }

  throw new AuthError(
    "API ключ не найден. Передай --key, или экспортируй BRIKKO_API_KEY, или запусти команду из терминала чтобы ввести ключ интерактивно.",
  );
}

export class AuthError extends Error {
  override name = "AuthError" as const;
}
