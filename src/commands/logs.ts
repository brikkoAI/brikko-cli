/**
 * `brikko logs [service] [--follow]` — tail compose logs.
 * Pass-through to `docker compose logs`. With --follow, child stdio is
 * inherited and we forward SIGINT to terminate cleanly.
 */

import { DEFAULT_INSTALL_DIR, composePath, pathExists } from "../lib/config.js";
import { compose, composeStream } from "../lib/docker.js";
import { log } from "../lib/logger.js";

export interface LogsOptions {
  dir?: string;
  follow?: boolean;
  /** Number of lines to show from the end. Default: 200 (compose default is "all"). */
  tail?: number;
}

export async function logs(service: string | undefined, opts: LogsOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;

  if (!(await pathExists(composePath(installDir)))) {
    log.err(`docker-compose.yml не найден в ${installDir}`);
    return 1;
  }

  const args: string[] = ["logs"];
  if (opts.follow) args.push("--follow");
  args.push("--tail", String(opts.tail ?? 200));
  if (service) args.push(service);

  if (opts.follow) {
    const child = composeStream(args, { cwd: installDir });
    // Forward SIGINT/SIGTERM to the child so Ctrl-C tears down cleanly.
    const onSignal = (sig: NodeJS.Signals): void => {
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const result = await child;
      return typeof result.exitCode === "number" ? result.exitCode : 0;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }

  try {
    const r = await compose(args, { cwd: installDir });
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return 0;
  } catch (e) {
    log.err(String((e as Error).message));
    return 1;
  }
}
