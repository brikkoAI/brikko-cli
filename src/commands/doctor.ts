/**
 * `brikko doctor` — diagnostics for a Brikko Studio install.
 *
 * Checks (each → green/yellow/red row):
 *   - docker installed + version
 *   - docker daemon alive
 *   - compose v2 + version
 *   - install dir exists + .env / docker-compose.yml present
 *   - port BRIKKO_PORT free OR bound by us
 *   - disk free >= 2 GB on installDir's volume
 *   - http://127.0.0.1:PORT/api/auth/status responds
 *
 * `--json` outputs structured findings for CI / scripted health checks.
 */

import { statfs } from "node:fs/promises";
import pc from "picocolors";
import {
  DEFAULT_INSTALL_DIR,
  composePath,
  envPath,
  pathExists,
  readBrikkoEnv,
} from "../lib/config.js";
import {
  composePs,
  composeVersion,
  dockerDaemonAlive,
  dockerVersion,
  hasDocker,
  hasComposeV2,
} from "../lib/docker.js";
import { isPortFree, probe, studioAuthUrl } from "../lib/healthcheck.js";
import { detectPlatform, platformLabel } from "../lib/platform.js";
import {
  composeInstallHint,
  daemonStartHint,
  dockerInstallHint,
  type CheckLevel,
  type CheckResult,
} from "../lib/preflight.js";

export interface DoctorOptions {
  dir?: string;
  json?: boolean;
}

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export async function doctor(opts: DoctorOptions): Promise<number> {
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;
  const platform = await detectPlatform();
  const checks: CheckResult[] = [];

  checks.push({
    id: "platform",
    level: "ok",
    message: `Platform: ${platformLabel(platform)}`,
  });

  // Docker
  if (!(await hasDocker())) {
    checks.push({
      id: "docker",
      level: "fail",
      message: "Docker not installed",
      hint: dockerInstallHint(platform),
    });
  } else {
    checks.push({
      id: "docker",
      level: "ok",
      message: (await dockerVersion()) ?? "docker available",
    });
    if (!(await dockerDaemonAlive())) {
      checks.push({
        id: "daemon",
        level: "fail",
        message: "Docker daemon not responding",
        hint: daemonStartHint(platform),
      });
    } else {
      checks.push({ id: "daemon", level: "ok", message: "Docker daemon: alive" });
    }
  }

  // Compose v2
  if (!(await hasComposeV2())) {
    checks.push({
      id: "compose",
      level: "fail",
      message: "Docker Compose v2 not installed",
      hint: composeInstallHint(platform),
    });
  } else {
    checks.push({
      id: "compose",
      level: "ok",
      message: `Compose ${(await composeVersion()) ?? "v2"}`,
    });
  }

  // Install dir + files
  const dirExists = await pathExists(installDir);
  if (!dirExists) {
    checks.push({
      id: "install-dir",
      level: "warn",
      message: `Install dir missing: ${installDir}`,
      hint: "Run `brikko init` to set up Brikko Studio.",
    });
  } else {
    checks.push({ id: "install-dir", level: "ok", message: `Install dir: ${installDir}` });
    if (!(await pathExists(composePath(installDir)))) {
      checks.push({
        id: "compose-file",
        level: "fail",
        message: "docker-compose.yml not found in install dir",
        hint: "Run `brikko init` (or `brikko update` to refresh compose template).",
      });
    } else {
      checks.push({ id: "compose-file", level: "ok", message: "docker-compose.yml: present" });
    }
    if (!(await pathExists(envPath(installDir)))) {
      checks.push({
        id: "env-file",
        level: "warn",
        message: ".env not found in install dir",
        hint: "Run `brikko init --force` to recreate.",
      });
    } else {
      checks.push({ id: "env-file", level: "ok", message: ".env: present" });
    }
  }

  // Port check (only meaningful if installed)
  if (dirExists && (await pathExists(composePath(installDir)))) {
    const env = await readBrikkoEnv(installDir);
    const services = await composePs(installDir);
    const ourPortInUse = services.some((s) => s.service === "core" && s.state === "running");

    if (ourPortInUse) {
      checks.push({
        id: "port",
        level: "ok",
        message: `Port ${env.port}: bound by Brikko Studio core`,
      });
    } else if (await isPortFree(env.port)) {
      checks.push({
        id: "port",
        level: "ok",
        message: `Port ${env.port}: free`,
      });
    } else {
      checks.push({
        id: "port",
        level: "fail",
        message: `Port ${env.port}: occupied by another process`,
        hint: `Change BRIKKO_PORT in ${envPath(installDir)} or stop the conflicting process.`,
      });
    }

    // Auth-status probe (only if core appears to be running)
    if (ourPortInUse) {
      const reachable = await probe(studioAuthUrl(env.port), 2000);
      checks.push({
        id: "studio-http",
        level: reachable ? "ok" : "fail",
        message: reachable
          ? `${studioAuthUrl(env.port)}: reachable`
          : `${studioAuthUrl(env.port)}: no response`,
        hint: reachable ? undefined : "brikko logs core --follow",
      });
    }
  }

  // Disk free
  const free = await getFreeBytes(installDir);
  if (free === null) {
    checks.push({
      id: "disk",
      level: "warn",
      message: "Could not determine free disk space",
    });
  } else if (free < MIN_FREE_BYTES) {
    checks.push({
      id: "disk",
      level: "warn",
      message: `Free disk: ${humanBytes(free)} (recommended >= 2 GB)`,
      hint: "Brikko images take ~1 GB; logs + workspace data grow over time.",
    });
  } else {
    checks.push({
      id: "disk",
      level: "ok",
      message: `Free disk: ${humanBytes(free)}`,
    });
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ platform, installDir, checks }, null, 2) + "\n");
  } else {
    printTable(checks);
  }

  const worst = worstLevel(checks);
  if (worst === "fail") return 1;
  return 0;
}

function printTable(checks: CheckResult[]): void {
  process.stdout.write(`${pc.bold("Brikko doctor")}\n\n`);
  for (const c of checks) {
    const dot =
      c.level === "ok" ? pc.green("●") : c.level === "warn" ? pc.yellow("●") : pc.red("●");
    process.stdout.write(`  ${dot} ${c.message}\n`);
    if (c.hint && c.level !== "ok") {
      process.stdout.write(`     ${pc.dim(c.hint)}\n`);
    }
  }
  process.stdout.write("\n");
  const worst = worstLevel(checks);
  if (worst === "fail") {
    process.stdout.write(pc.red("Some checks failed. See hints above.\n"));
  } else if (worst === "warn") {
    process.stdout.write(pc.yellow("Warnings — Brikko should still work.\n"));
  } else {
    process.stdout.write(pc.green("All systems green.\n"));
  }
}

function worstLevel(checks: CheckResult[]): CheckLevel {
  if (checks.some((c) => c.level === "fail")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "ok";
}

async function getFreeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    // Path may not exist; try parent.
    try {
      const parent = path.replace(/[\\/][^\\/]+$/, "") || path;
      const s = await statfs(parent);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }
}

function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}
