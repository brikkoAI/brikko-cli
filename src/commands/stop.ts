/**
 * `brikko stop` — stop containers but keep them around (compose stop, not down).
 * Volumes + networks survive; restart with `brikko start` is fast.
 */

import ora from "ora";
import { DEFAULT_INSTALL_DIR, composePath, pathExists } from "../lib/config.js";
import { compose } from "../lib/docker.js";
import { log } from "../lib/logger.js";

export interface StopOptions {
  dir?: string;
}

export async function stop(opts: StopOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;

  if (!(await pathExists(composePath(installDir)))) {
    log.err(`docker-compose.yml не найден в ${installDir}`);
    log.hint("Нечего останавливать. Если ставил в нестандартную папку — передай --dir.");
    return 1;
  }

  const spinner = ora("Останавливаю сервисы…").start();
  try {
    await compose(["stop"], { cwd: installDir });
    spinner.succeed("Сервисы остановлены. Данные сохранены.");
    log.info("Запустить снова: brikko start");
    return 0;
  } catch (e) {
    spinner.fail("Не удалось остановить.");
    log.err(String((e as Error).message));
    return 1;
  }
}
