/**
 * `brikko version` — print CLI version + (when reachable) Studio Core version
 * via `/api/version`. Falls back to compose image tag if Core is unreachable.
 */

import pc from "picocolors";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_INSTALL_DIR,
  composePath,
  pathExists,
  readBrikkoEnv,
} from "../lib/config.js";
import { composePs } from "../lib/docker.js";
import { dockerVersion as getDockerVersion, composeVersion as getComposeVersion } from "../lib/docker.js";
import { probe } from "../lib/healthcheck.js";
import { log } from "../lib/logger.js";

export interface VersionOptions {
  dir?: string;
  json?: boolean;
}

interface VersionReport {
  cli: string;
  installDir: string | null;
  studioVersion: string | null;
  studioRunning: boolean;
  docker: string | null;
  compose: string | null;
}

/**
 * Read package.json version. We resolve relative to import.meta.url so
 * `brikko version` works after `npm i -g`.
 */
export async function readCliVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/commands → ../../package.json
    const pkgPath = resolve(here, "..", "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function version(opts: VersionOptions): Promise<number> {
  const cliVer = await readCliVersion();
  const installDir = opts.dir ?? DEFAULT_INSTALL_DIR;
  const installed = await pathExists(composePath(installDir));

  let studioVersion: string | null = null;
  let studioRunning = false;
  if (installed) {
    const env = await readBrikkoEnv(installDir);
    studioVersion = env.version;
    const services = await composePs(installDir);
    studioRunning = services.some((s) => s.service === "core" && s.state === "running");
    if (studioRunning) {
      // Ask Core directly — more accurate than the .env tag (esp. for "latest").
      const live = await fetchStudioVersion(`http://127.0.0.1:${env.port}/api/version`);
      if (live) studioVersion = live;
    }
  }

  const report: VersionReport = {
    cli: cliVer,
    installDir: installed ? installDir : null,
    studioVersion,
    studioRunning,
    docker: await getDockerVersion(),
    compose: await getComposeVersion(),
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }

  process.stdout.write(`${pc.bold("brikko-cli")} ${pc.green(report.cli)}\n`);
  if (report.installDir) {
    process.stdout.write(
      `Studio:  ${report.studioVersion ?? "?"} ${
        report.studioRunning ? pc.green("(running)") : pc.dim("(stopped)")
      }\n`,
    );
    process.stdout.write(`Install: ${report.installDir}\n`);
  } else {
    process.stdout.write(`Studio:  ${pc.dim("not installed")}  (run brikko init)\n`);
  }
  process.stdout.write(`Docker:  ${report.docker ?? pc.red("not found")}\n`);
  process.stdout.write(`Compose: ${report.compose ?? pc.red("not found")}\n`);
  return 0;
}

async function fetchStudioVersion(url: string): Promise<string | null> {
  // We can't pass a body-parser dep; do the fetch manually with timeout.
  if (!(await probe(url, 1500))) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = (await r.json()) as { version?: string };
    return j.version ?? null;
  } catch {
    return null;
  }
}

// Avoid "imported but unused" with `join` in case future patches need it.
export const _join = join;

// Suppress lint: log used by other commands; here we keep it imported so
// fail-paths can switch from process.stdout to log.* without a re-import.
export const _log = log;
