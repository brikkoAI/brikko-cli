/**
 * `brikko down` — full compose down. Removes containers + networks but keeps
 * named volumes (brikko-state with workspace data, brikko-config with policies).
 * For a destructive wipe use `brikko uninstall`.
 */

import ora from "ora";
import { DEFAULT_INSTALL_DIR, composePath, pathExists } from "../lib/config.js";
import { compose } from "../lib/docker.js";
import { log } from "../lib/logger.js";

export interface DownOptions {
  dir?: string;
}

export async function down(opts: DownOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;

  if (!(await pathExists(composePath(installDir)))) {
    log.err(`docker-compose.yml не найден в ${installDir}`);
    return 1;
  }

  const spinner = ora("Останавливаю и удаляю контейнеры (тома сохраняются)…").start();
  try {
    await compose(["down"], { cwd: installDir });
    spinner.succeed("Контейнеры удалены. Volumes (brikko-state, brikko-config) сохранены.");
    log.info("Полное удаление с данными: brikko uninstall");
    return 0;
  } catch (e) {
    spinner.fail("Не удалось выполнить down.");
    log.err(String((e as Error).message));
    return 1;
  }
}
