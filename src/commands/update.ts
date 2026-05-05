/**
 * `brikko update` — pull latest images + recreate containers.
 *
 * We also refresh the bundled docker-compose.yml — patch releases of
 * brikko-cli ship updated compose files (e.g. new healthcheck rules,
 * additional services). Users get those by `npm i -g brikko-cli@latest`
 * followed by `brikko update`.
 */

import ora from "ora";
import { DEFAULT_INSTALL_DIR, composePath, pathExists, readBrikkoEnv } from "../lib/config.js";
import { compose } from "../lib/docker.js";
import { studioAuthUrl, waitForHealthy } from "../lib/healthcheck.js";
import { log } from "../lib/logger.js";
import { copyComposeTemplate } from "../lib/templates.js";

export interface UpdateOptions {
  dir?: string;
  /** Skip refreshing the bundled docker-compose.yml. */
  keepCompose?: boolean;
  /** Skip the healthcheck wait. */
  noWait?: boolean;
}

export async function update(opts: UpdateOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;

  if (!(await pathExists(composePath(installDir)))) {
    log.err(`docker-compose.yml не найден в ${installDir}. Сначала brikko init.`);
    return 1;
  }

  // 1. Refresh compose template (bundled with this CLI version).
  if (!opts.keepCompose) {
    await copyComposeTemplate(installDir);
    log.ok("docker-compose.yml обновлён из бандла brikko-cli.");
  }

  // 2. Pull latest images.
  const pullSpinner = ora("Скачиваю свежие образы…").start();
  try {
    await compose(["pull"], { cwd: installDir });
    pullSpinner.succeed("Образы скачаны.");
  } catch (e) {
    pullSpinner.fail("Не удалось скачать образы.");
    log.err(String((e as Error).message));
    return 1;
  }

  // 3. Re-up with new images.
  const upSpinner = ora("Пересоздаю контейнеры (docker compose up -d)…").start();
  try {
    await compose(["up", "-d"], { cwd: installDir });
    upSpinner.succeed("Контейнеры пересозданы.");
  } catch (e) {
    upSpinner.fail("Не удалось обновить.");
    log.err(String((e as Error).message));
    return 1;
  }

  // 4. Wait for healthy.
  if (!opts.noWait) {
    const env = await readBrikkoEnv(installDir);
    const hc = ora("Жду готовности Studio Core…").start();
    const ok = await waitForHealthy(studioAuthUrl(env.port), { timeoutMs: 90_000 });
    if (ok) hc.succeed("Studio Core готов.");
    else {
      hc.fail("Studio Core не ответил за 90 секунд.");
      log.hint("brikko logs core --follow");
      return 1;
    }
  }

  log.ok("Обновление завершено.");
  return 0;
}
