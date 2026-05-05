/**
 * `brikko restart [service]` — `docker compose restart [service]`.
 */

import ora from "ora";
import { DEFAULT_INSTALL_DIR, composePath, pathExists, readBrikkoEnv } from "../lib/config.js";
import { compose } from "../lib/docker.js";
import { studioAuthUrl, waitForHealthy } from "../lib/healthcheck.js";
import { log } from "../lib/logger.js";

export interface RestartOptions {
  dir?: string;
  noWait?: boolean;
}

export async function restart(
  service: string | undefined,
  opts: RestartOptions,
): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;

  if (!(await pathExists(composePath(installDir)))) {
    log.err(`docker-compose.yml не найден в ${installDir}`);
    return 1;
  }

  const args = ["restart"];
  if (service) args.push(service);

  const label = service ? `Перезапускаю ${service}…` : "Перезапускаю все сервисы…";
  const spinner = ora(label).start();
  try {
    await compose(args, { cwd: installDir });
    spinner.succeed(service ? `${service} перезапущен.` : "Сервисы перезапущены.");
  } catch (e) {
    spinner.fail("Не удалось перезапустить.");
    log.err(String((e as Error).message));
    return 1;
  }

  if (!opts.noWait && (!service || service === "core")) {
    const env = await readBrikkoEnv(installDir);
    const hc = ora("Жду готовности Studio Core…").start();
    const ok = await waitForHealthy(studioAuthUrl(env.port), { timeoutMs: 60_000 });
    if (ok) hc.succeed("Studio Core готов.");
    else {
      hc.fail("Studio Core не ответил за 60 секунд.");
      return 1;
    }
  }
  return 0;
}
