/**
 * `brikko status` — table of compose services + health check + version.
 * `--json` outputs machine-readable JSON (for CI / scripting).
 */

import pc from "picocolors";
import {
  DEFAULT_INSTALL_DIR,
  composePath,
  pathExists,
  readBrikkoEnv,
} from "../lib/config.js";
import { composePs, type ComposePsRow } from "../lib/docker.js";
import { probe, studioAuthUrl } from "../lib/healthcheck.js";
import { log } from "../lib/logger.js";

export interface StatusOptions {
  dir?: string;
  json?: boolean;
}

interface StatusReport {
  installDir: string;
  port: number;
  version: string;
  studioReachable: boolean;
  studioUrl: string;
  services: ComposePsRow[];
}

export async function status(opts: StatusOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;

  if (!(await pathExists(composePath(installDir)))) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { installed: false, installDir, error: "no docker-compose.yml" },
          null,
          2,
        ) + "\n",
      );
    } else {
      log.warn(`Brikko Studio не установлен в ${installDir}`);
      log.hint("Запусти: brikko init");
    }
    return 1;
  }

  const env = await readBrikkoEnv(installDir);
  const services = await composePs(installDir);
  const studioUrl = studioAuthUrl(env.port);
  const reachable = await probe(studioUrl, 2000);

  const report: StatusReport = {
    installDir,
    port: env.port,
    version: env.version,
    studioReachable: reachable,
    studioUrl: `http://localhost:${env.port}`,
    services,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return reachable ? 0 : 1;
  }

  printHumanReport(report);
  return reachable ? 0 : 1;
}

function printHumanReport(r: StatusReport): void {
  process.stdout.write(`${pc.bold("Brikko Studio")} — ${r.installDir}\n`);
  process.stdout.write(`  Port:    ${r.port}\n`);
  process.stdout.write(`  Version: ${r.version}\n`);
  process.stdout.write(`  Web UI:  ${r.studioUrl}  ${reachableDot(r.studioReachable)}\n\n`);

  if (r.services.length === 0) {
    log.warn("Контейнеры не запущены. brikko start чтобы поднять.");
    return;
  }
  process.stdout.write(pc.bold("Services:\n"));
  for (const s of r.services) {
    const st = colorState(s.state);
    const health = s.health ? ` (${s.health})` : "";
    process.stdout.write(`  ${st}  ${s.service.padEnd(12)} ${pc.dim(s.status)}${health}\n`);
  }
}

function colorState(state: string): string {
  if (state === "running") return pc.green("●");
  if (state === "exited" || state === "dead") return pc.red("●");
  if (state === "restarting" || state === "paused") return pc.yellow("●");
  return pc.dim("○");
}

function reachableDot(ok: boolean): string {
  return ok ? pc.green("✓ reachable") : pc.red("✗ unreachable");
}
