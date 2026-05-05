/**
 * `brikko uninstall` — destructive. compose down -v + rm -rf installDir.
 * Always confirms unless --yes. Removes named volumes (workspace data,
 * audit log) — irreversible.
 */

import { rm } from "node:fs/promises";
import ora from "ora";
import prompts from "prompts";
import { DEFAULT_INSTALL_DIR, composePath, pathExists } from "../lib/config.js";
import { compose } from "../lib/docker.js";
import { log } from "../lib/logger.js";

export interface UninstallOptions {
  dir?: string;
  yes?: boolean;
  /** Keep the install directory itself; only `compose down -v`. */
  keepDir?: boolean;
}

export async function uninstall(opts: UninstallOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;

  if (!(await pathExists(installDir))) {
    log.warn(`Папка ${installDir} не существует — нечего удалять.`);
    return 0;
  }

  if (!opts.yes) {
    log.warn("Удаление НЕОБРАТИМО:");
    log.warn("  • контейнеры удаляются");
    log.warn("  • named volumes brikko-state и brikko-config удаляются (workspace data!)");
    if (!opts.keepDir) log.warn(`  • папка ${installDir} удаляется`);

    const { ok } = await prompts({
      type: "confirm",
      name: "ok",
      message: "Точно удалить?",
      initial: false,
    });
    if (!ok) {
      log.info("Отменено.");
      return 2;
    }
  }

  // 1. compose down -v (skip silently if compose file is missing)
  if (await pathExists(composePath(installDir))) {
    const spinner = ora("docker compose down -v…").start();
    try {
      await compose(["down", "-v"], { cwd: installDir });
      spinner.succeed("Контейнеры и volumes удалены.");
    } catch (e) {
      spinner.fail("docker compose down -v завершился с ошибкой (продолжаю удаление папки).");
      log.warn(String((e as Error).message));
    }
  }

  // 2. rm -rf installDir
  if (!opts.keepDir) {
    const spinner = ora(`Удаляю ${installDir}…`).start();
    try {
      await rm(installDir, { recursive: true, force: true });
      spinner.succeed(`Папка удалена: ${installDir}`);
    } catch (e) {
      spinner.fail("Не удалось удалить папку.");
      log.err(String((e as Error).message));
      return 1;
    }
  }

  log.ok("Brikko Studio удалён.");
  log.info("CLI всё ещё установлен. Чтобы убрать его: npm uninstall -g brikko-cli");
  return 0;
}
