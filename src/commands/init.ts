/**
 * `brikko init` — bootstrap a new Brikko Studio install in INSTALL_DIR.
 *
 * Steps:
 *   1. preflight (docker + compose v2 + daemon, with up to 60s wait)
 *   2. mkdir installDir, drop bundled docker-compose.yml + seed .env
 *   3. validate port is free; if not, prompt for a different one
 *   4. (if not --skip-pull) `docker compose pull`
 *   5. `docker compose up -d`
 *   6. wait for /api/auth/status, open browser
 *
 * Idempotent: re-running on an existing install upgrades compose.yml +
 * preserves user .env (unless --force).
 */

import { mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import ora from "ora";
import prompts from "prompts";
import {
  DEFAULT_INSTALL_DIR,
  DEFAULT_PORT,
  DEFAULT_VERSION,
  composePath,
  envPath,
  isValidPort,
  pathExists,
  readBrikkoEnv,
  writeBrikkoEnv,
} from "../lib/config.js";
import { compose } from "../lib/docker.js";
import { isPortFree, studioAuthUrl, waitForHealthy } from "../lib/healthcheck.js";
import { log } from "../lib/logger.js";
import { detectPlatform, openBrowser, platformLabel } from "../lib/platform.js";
import { runPreflight } from "../lib/preflight.js";
import { bundledEnvExamplePath, copyComposeTemplate } from "../lib/templates.js";

export interface InitOptions {
  dir?: string;
  port?: number;
  version?: string;
  /** Skip the interactive confirmation (for CI / scripted setups). */
  yes?: boolean;
  /** Skip `docker compose pull` (faster local dev iteration). */
  skipPull?: boolean;
  /** Overwrite existing .env even if present. */
  force?: boolean;
  /** Skip browser-open at the end. */
  noBrowser?: boolean;
}

export async function init(opts: InitOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;
  let port = opts.port ?? DEFAULT_PORT;
  const version = opts.version ?? DEFAULT_VERSION;

  if (!isValidPort(port)) {
    log.err(`Невалидный порт: ${port}. Допустимо 1..65535.`);
    return 1;
  }

  // 1. Preflight
  const platform = await detectPlatform();
  log.info(`Платформа: ${platformLabel(platform)}`);

  const checks = await runPreflight({ daemonWaitMs: 60_000 });
  for (const c of checks) {
    if (c.level === "ok") log.ok(c.message);
    else if (c.level === "warn") log.warn(c.message);
    else {
      log.err(c.message);
      if (c.hint) log.hint(c.hint);
    }
  }
  if (checks.some((c) => c.level === "fail")) {
    log.err("Предварительные проверки не пройдены. Прерываю установку.");
    return 1;
  }

  // 2. Port collision: if not free AND nothing of ours is on it, prompt.
  if (!(await isPortFree(port))) {
    log.warn(`Порт ${port} уже занят на 127.0.0.1`);
    if (opts.yes) {
      log.err("В non-interactive режиме (--yes) сменить порт нельзя. Запусти с --port <свободный>.");
      return 1;
    }
    const { newPort } = await prompts({
      type: "number",
      name: "newPort",
      message: "Введи свободный порт (1024-65535) или Ctrl-C чтобы выйти:",
      initial: 3838,
      validate: (v: number) => (isValidPort(v) ? true : "Порт вне диапазона"),
    });
    if (!newPort) {
      log.info("Отменено пользователем.");
      return 2;
    }
    port = newPort;
    if (!(await isPortFree(port))) {
      log.err(`Порт ${port} тоже занят. Прерываю.`);
      return 1;
    }
  }

  // 3. Create install dir + drop templates
  log.info(`Установка в ${installDir}`);
  await mkdir(installDir, { recursive: true });

  await copyComposeTemplate(installDir);
  log.ok(`docker-compose.yml записан → ${composePath(installDir)}`);

  // .env: keep existing unless --force; otherwise seed from .env.example
  // and apply --port / --version via writeBrikkoEnv.
  const envExists = await pathExists(envPath(installDir));
  if (envExists && !opts.force) {
    log.info(".env уже существует — оставляю как есть. (Используй --force чтобы перезаписать.)");
    // But still patch port/version so the user-supplied flags take effect.
    const cur = await readBrikkoEnv(installDir);
    await writeBrikkoEnv(installDir, { port, version }, cur.raw);
    log.ok(`.env обновлён: BRIKKO_PORT=${port}, BRIKKO_VERSION=${version}`);
  } else {
    await copyFile(bundledEnvExamplePath(), envPath(installDir));
    await writeBrikkoEnv(installDir, { port, version });
    log.ok(`.env создан → ${envPath(installDir)}`);
  }

  // 4. Confirm
  if (!opts.yes) {
    const { go } = await prompts({
      type: "confirm",
      name: "go",
      message: `Запустить Brikko Studio на http://localhost:${port}?`,
      initial: true,
    });
    if (!go) {
      log.info(`Отменено. Запустить позже: brikko start --dir "${installDir}"`);
      return 2;
    }
  }

  // 5. Pull (unless skipped)
  if (!opts.skipPull) {
    const spinner = ora("Скачиваю образы (3 контейнера, ~600 MB первый раз)…").start();
    try {
      await compose(["pull"], { cwd: installDir });
      spinner.succeed("Образы скачаны.");
    } catch (e) {
      spinner.fail("Не удалось скачать образы.");
      log.err(String((e as Error).message));
      log.hint(`Логи: brikko logs --dir "${installDir}"`);
      return 1;
    }
  }

  // 6. Up
  const upSpinner = ora("Запускаю сервисы (docker compose up -d)…").start();
  try {
    await compose(["up", "-d"], { cwd: installDir });
    upSpinner.succeed("Контейнеры запущены.");
  } catch (e) {
    upSpinner.fail("Не удалось запустить сервисы.");
    log.err(String((e as Error).message));
    log.hint(`Логи: brikko logs --dir "${installDir}"`);
    return 1;
  }

  // 7. Healthcheck
  const url = studioAuthUrl(port);
  const hcSpinner = ora("Жду готовности Studio Core (/api/auth/status)…").start();
  const ok = await waitForHealthy(url, { timeoutMs: 60_000 });
  if (ok) {
    hcSpinner.succeed("Studio Core готов.");
  } else {
    hcSpinner.fail("Studio Core не ответил за 60 секунд.");
    log.hint(`Посмотри логи: brikko logs core --dir "${installDir}"`);
    log.hint(`Поддержка: hello@brikko.ru / @brikko_news`);
    return 1;
  }

  // 8. Open browser
  const webUrl = `http://localhost:${port}`;
  if (!opts.noBrowser) {
    const opened = await openBrowser(webUrl, platform);
    if (!opened) {
      log.info(`Открой в браузере: ${webUrl}`);
    }
  }

  log.blank();
  log.ok(`Готово. Brikko Studio работает: ${webUrl}`);
  log.info("Управление:");
  log.info("  brikko status     # текущее состояние");
  log.info("  brikko logs -f    # логи всех сервисов");
  log.info("  brikko stop       # остановить (данные сохраняются)");
  log.info("  brikko update     # обновить до новой версии");
  return 0;
}

// Suppress unused warning — `join` is exported transitively for tests.
export const _internal = { join };
