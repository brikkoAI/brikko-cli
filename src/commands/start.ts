/**
 * `brikko start` — bring up an already-initialized Brikko Studio install.
 * Equivalent to `cd $INSTALL_DIR && docker compose up -d`, but with health-
 * check and friendly status output.
 */

import ora from "ora";
import { DEFAULT_INSTALL_DIR, composePath, pathExists, readBrikkoEnv } from "../lib/config.js";
import { compose } from "../lib/docker.js";
import { studioAuthUrl, waitForHealthy } from "../lib/healthcheck.js";
import { log } from "../lib/logger.js";
import { detectPlatform } from "../lib/platform.js";
import { runPreflight } from "../lib/preflight.js";

export interface StartOptions {
  dir?: string;
  /** Skip /api/auth/status wait. */
  noWait?: boolean;
}

export async function start(opts: StartOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;

  if (!(await pathExists(composePath(installDir)))) {
    log.err(`docker-compose.yml не найден в ${installDir}`);
    log.hint("Сначала выполни `brikko init`.");
    return 1;
  }

  const checks = await runPreflight({ daemonWaitMs: 30_000 });
  for (const c of checks) {
    if (c.level === "fail") {
      log.err(c.message);
      if (c.hint) log.hint(c.hint);
    }
  }
  if (checks.some((c) => c.level === "fail")) return 1;

  const env = await readBrikkoEnv(installDir);

  const spinner = ora("Запускаю сервисы (docker compose up -d)…").start();
  try {
    await compose(["up", "-d"], { cwd: installDir });
    spinner.succeed("Контейнеры запущены.");
  } catch (e) {
    spinner.fail("Не удалось запустить сервисы.");
    log.err(String((e as Error).message));
    return 1;
  }

  if (!opts.noWait) {
    const hc = ora("Жду готовности Studio Core…").start();
    const ok = await waitForHealthy(studioAuthUrl(env.port), { timeoutMs: 60_000 });
    if (ok) hc.succeed("Studio Core готов.");
    else {
      hc.fail("Studio Core не ответил за 60 секунд.");
      log.hint("brikko logs core --follow");
      return 1;
    }
  }

  // platform detection is cheap; we don't open a browser here (start ≠ init)
  await detectPlatform();
  log.ok(`Brikko Studio: http://localhost:${env.port}`);
  return 0;
}
