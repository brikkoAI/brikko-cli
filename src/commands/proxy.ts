/**
 * `brikko proxy *` — local OpenAI-compatible proxy with PII protection.
 *
 * Subcommands:
 *   start     — spawn a detached daemon (default), or run in foreground
 *   stop      — SIGTERM the running daemon
 *   status    — print state + counters
 *   logs      — tail ~/.brikko/proxy.log (NDJSON)
 *
 * Why a local proxy: it lets users point ANY OpenAI SDK at
 * http://127.0.0.1:11434 with `OPENAI_API_KEY=anything` and get the
 * full Brikko experience (smart routing, billing, PII masking) without
 * touching their codebase. Drop-in replacement for openai.com.
 *
 * One process per user (V0.3). Multi-port + multi-instance is V0.4.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveAuth, AuthError, DEFAULT_API_BASE } from "../lib/auth.js";
import {
  readLiveState,
  writeState,
  clearState,
  spawnDaemon,
  killDaemon,
  waitForHealthz,
  isAlive,
} from "../lib/proxy/daemon.js";
import { startServer } from "../lib/proxy/server.js";
import { createLogger } from "../lib/proxy/logger.js";
import { proxyLogPath } from "../lib/paths.js";
import { pathExists } from "../lib/config.js";
import { log } from "../lib/logger.js";

export const DEFAULT_PROXY_PORT = 11434;

/* ========================================================================= */
/* proxy start                                                               */
/* ========================================================================= */

export interface ProxyStartOptions {
  port?: number | undefined;
  /** Disable the anonymize → forward → restore pipeline. */
  noPiiProtect?: boolean | undefined;
  /** Don't fork — run the server in this process (used by the daemon child). */
  foreground?: boolean | undefined;
  force?: boolean | undefined;
  key?: string | undefined;
}

export async function proxyStart(opts: ProxyStartOptions): Promise<number> {
  const port = opts.port ?? DEFAULT_PROXY_PORT;
  const piiProtect = !opts.noPiiProtect;

  if (opts.foreground) {
    return await runForeground(port, piiProtect, opts.key);
  }

  // Manager mode: check existing daemon, spawn a child, wait for /healthz.
  const existing = await readLiveState();
  if (existing) {
    if (!opts.force) {
      log.err(`Прокси уже запущен на порту ${existing.port} (PID ${existing.pid}).`);
      log.hint("Останови его командой 'brikko proxy stop' или используй --force.");
      return 1;
    }
    log.warn(`Останавливаю текущий прокси (PID ${existing.pid})...`);
    await killDaemon(existing.pid);
    await clearState();
  }

  // Resolve auth NOW — better to fail fast than spawn a child that crashes.
  let auth;
  try {
    auth = await resolveAuth({ key: opts.key, interactive: true });
  } catch (e) {
    if (e instanceof AuthError) {
      log.err(e.message);
      return 1;
    }
    throw e;
  }

  // Find dist/cli.js — same script we're running.
  const cliJs = await locateCliJs();
  if (!cliJs) {
    log.err("Не нашёл путь к dist/cli.js — установка повреждена. Переустанови brikko-cli.");
    return 1;
  }

  log.info(
    `Запускаю прокси на http://127.0.0.1:${port} (PII protection: ${piiProtect ? "ON" : "OFF"})...`,
  );

  let pid: number;
  try {
    pid = spawnDaemon({
      cliJs,
      port,
      apiBase: auth.apiBase,
      piiProtect,
    });
  } catch (err) {
    log.err(`Не удалось запустить демон: ${(err as Error).message}`);
    return 1;
  }

  // Wait until the daemon is actually listening.
  const health = await waitForHealthz(port, 10_000);
  if (!health) {
    log.err("Демон стартовал, но /healthz не ответил за 10 сек.");
    log.hint(`Лог: ${proxyLogPath()}`);
    // Try to clean up the orphan.
    if (isAlive(pid)) await killDaemon(pid);
    return 1;
  }

  const cliVersion = await readCliVersion();
  await writeState({
    pid,
    port,
    apiBase: auth.apiBase,
    piiProtect,
    startedAt: Date.now(),
    cliVersion,
  });

  log.ok(`Прокси работает на http://127.0.0.1:${port} (PID ${pid})`);
  log.info("Использование с OpenAI SDK:");
  log.info(`  OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`);
  log.info("  OPENAI_API_KEY=any-string-works  (ключ Brikko уже сохранён в демоне)");
  log.info(`Лог: ${proxyLogPath()}`);
  return 0;
}

/**
 * Run the server in this very process. Used by the daemon child. Blocks
 * forever until SIGTERM/SIGINT.
 */
async function runForeground(
  port: number,
  piiProtect: boolean,
  keyOverride?: string,
): Promise<number> {
  const auth = await resolveAuth({
    key: keyOverride,
    interactive: false,
  }).catch((err) => {
    process.stderr.write(`[brikko proxy] auth failed: ${(err as Error).message}\n`);
    process.exit(1);
  });

  const logger = await createLogger({ mirrorToStderr: false });
  const cliVersion = await readCliVersion();

  const handle = await startServer({
    port,
    apiBase: auth.apiBase || DEFAULT_API_BASE,
    apiKey: auth.apiKey,
    piiProtect,
    logger,
    cliVersion,
  });

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server.shutdown", { signal });
    handle
      .close()
      .catch(() => undefined)
      .finally(() => {
        logger.close().finally(() => process.exit(0));
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Block forever.
  return await new Promise<number>(() => {
    /* never resolves */
  });
}

/* ========================================================================= */
/* proxy stop                                                                */
/* ========================================================================= */

export interface ProxyStopOptions {
  port?: number | undefined; // ignored in V0.3 — single daemon
}

export async function proxyStop(_opts: ProxyStopOptions): Promise<number> {
  const state = await readLiveState();
  if (!state) {
    log.warn("Прокси не запущен.");
    return 0;
  }
  log.info(`Останавливаю прокси на порту ${state.port} (PID ${state.pid})...`);
  const ok = await killDaemon(state.pid);
  await clearState();
  if (!ok) {
    log.err(`Не удалось остановить процесс ${state.pid}.`);
    return 1;
  }
  log.ok("Прокси остановлен.");
  return 0;
}

/* ========================================================================= */
/* proxy status                                                              */
/* ========================================================================= */

export interface ProxyStatusOptions {
  json?: boolean | undefined;
}

export async function proxyStatus(opts: ProxyStatusOptions): Promise<number> {
  const state = await readLiveState();
  if (!state) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ running: false }) + "\n");
    } else {
      log.warn("Прокси не запущен.");
    }
    return 0;
  }

  // Hit /healthz for live counters.
  let health: Record<string, unknown> | null = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${state.port}/healthz`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (r.ok) health = (await r.json()) as Record<string, unknown>;
  } catch {
    /* daemon alive but not responding — surface that below */
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          running: true,
          ...state,
          uptime_s: Math.round((Date.now() - state.startedAt) / 1000),
          healthz: health,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const uptimeS = Math.round((Date.now() - state.startedAt) / 1000);
  log.ok(`Прокси работает на http://127.0.0.1:${state.port} (PID ${state.pid})`);
  log.info(`Uptime: ${formatDuration(uptimeS)}`);
  log.info(`PII protection: ${state.piiProtect ? "ON" : "OFF"}`);
  log.info(`Upstream: ${state.apiBase}`);
  if (health) {
    const counters = (health["counters"] as Record<string, unknown>) ?? {};
    log.info(`Запросов: ${counters["requests"] ?? 0}`);
    log.info(`PII masks: ${counters["masks"] ?? 0}`);
    log.info(`Errors: ${counters["errors"] ?? 0}`);
    log.info(`Upstream OK: ${health["upstream_ok"] ? "да" : "нет"}`);
  } else {
    log.warn("Демон жив, но /healthz не отвечает — что-то не так.");
  }
  return 0;
}

/* ========================================================================= */
/* proxy logs                                                                */
/* ========================================================================= */

export interface ProxyLogsOptions {
  follow?: boolean | undefined;
  tail?: number | undefined;
}

export async function proxyLogs(opts: ProxyLogsOptions): Promise<number> {
  const path = proxyLogPath();
  if (!(await pathExists(path))) {
    log.warn(`Лог-файл не найден: ${path}`);
    log.hint("Прокси ни разу не запускался?");
    return 0;
  }

  const tail = opts.tail ?? 100;
  // Read last N lines.
  const all = (await readFile(path, "utf8")).split("\n").filter((l) => l.length > 0);
  const slice = tail > 0 ? all.slice(-tail) : all;
  for (const line of slice) {
    process.stdout.write(line + "\n");
  }

  if (!opts.follow) return 0;

  // Naive --follow: re-read file every 500ms, print new lines.
  let lastSize = Buffer.byteLength(all.join("\n"), "utf8");
  const onSigint = (): void => process.exit(0);
  process.on("SIGINT", onSigint);
  try {
    for (;;) {
      await sleep(500);
      const current = await readFile(path, "utf8");
      const currentBytes = Buffer.byteLength(current, "utf8");
      if (currentBytes > lastSize) {
        const fresh = current.slice(lastSize);
        process.stdout.write(fresh);
        lastSize = currentBytes;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

/* ========================================================================= */
/* helpers                                                                   */
/* ========================================================================= */

async function locateCliJs(): Promise<string | null> {
  // commands/proxy.js → ../cli.js after build.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolvePath(here, "..", "cli.js");
  return (await pathExists(candidate)) ? candidate : null;
}

async function readCliVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      await readFile(resolvePath(here, "..", "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
