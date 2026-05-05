/**
 * brikko-cli entrypoint.
 *
 * Exit codes (per docs/CLI.md):
 *   0 — success
 *   1 — error (preflight failed, command failed, etc.)
 *   2 — user cancelled (Ctrl-C, declined prompt)
 *
 * The shebang `#!/usr/bin/env node` is added by scripts/add-shebang.js
 * during build (TypeScript can't emit shebangs natively).
 */

import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { init } from "./commands/init.js";
import { start } from "./commands/start.js";
import { stop } from "./commands/stop.js";
import { down } from "./commands/down.js";
import { status } from "./commands/status.js";
import { logs } from "./commands/logs.js";
import { restart } from "./commands/restart.js";
import { update } from "./commands/update.js";
import { uninstall } from "./commands/uninstall.js";
import { doctor } from "./commands/doctor.js";
import { version as versionCmd } from "./commands/version.js";
import { log } from "./lib/logger.js";

async function readPkgVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      await readFile(resolve(here, "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Wrap an async command handler so unexpected throws map to exit code 1. */
function safe(fn: () => Promise<number>): () => Promise<void> {
  return async () => {
    try {
      const code = await fn();
      process.exit(code);
    } catch (err) {
      log.err(`Unexpected error: ${(err as Error).message}`);
      if (process.env["DEBUG"]) {
        console.error(err);
      }
      process.exit(1);
    }
  };
}

function parsePositiveInt(label: string) {
  return (value: string): number => {
    const n = Number.parseInt(value, 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${label} must be a positive integer (got "${value}")`);
    }
    return n;
  };
}

async function main(): Promise<void> {
  const program = new Command();
  const cliVersion = await readPkgVersion();

  program
    .name("brikko")
    .description(
      "Official CLI for Brikko Studio — local AI agent with reversible PII anonymization (152-FZ).",
    )
    .version(cliVersion, "-V, --version", "Output the brikko-cli version")
    .showHelpAfterError(true)
    .configureOutput({
      // commander writes to stderr for help-after-error; that's fine.
    });

  // Hide the auto --help from the global help summary; commander still
  // wires it up. Keep --help working on every subcommand.

  /* ------------------------------ init ------------------------------ */
  program
    .command("init")
    .description("Bootstrap a new Brikko Studio install (compose, .env, pull, up).")
    .option("--dir <path>", "Install directory", undefined)
    .option("--port <number>", "Web UI port (default: 3737)", parsePositiveInt("--port"))
    .option("--version <tag>", "Image tag for studio-core/anonymizer (default: latest)")
    .option("--yes", "Non-interactive: skip confirmations")
    .option("--force", "Overwrite existing .env")
    .option("--skip-pull", "Skip docker compose pull (use cached images)")
    .option("--no-browser", "Don't open the browser at the end")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        init({
          dir: opts["dir"] as string | undefined,
          port: opts["port"] as number | undefined,
          version: opts["version"] as string | undefined,
          yes: Boolean(opts["yes"]),
          skipPull: Boolean(opts["skipPull"]),
          force: Boolean(opts["force"]),
          // commander flips --no-browser into opts.browser=false
          noBrowser: opts["browser"] === false,
        }),
      )(),
    );

  /* ------------------------------ start ----------------------------- */
  program
    .command("start")
    .description("Start Brikko Studio (compose up -d).")
    .option("--dir <path>", "Install directory")
    .option("--no-wait", "Don't wait for /api/auth/status")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        start({
          dir: opts["dir"] as string | undefined,
          noWait: opts["wait"] === false,
        }),
      )(),
    );

  /* ------------------------------ stop ------------------------------ */
  program
    .command("stop")
    .description("Stop containers, keep volumes (compose stop).")
    .option("--dir <path>", "Install directory")
    .action((opts: Record<string, unknown>) =>
      safe(() => stop({ dir: opts["dir"] as string | undefined }))(),
    );

  /* ------------------------------ down ------------------------------ */
  program
    .command("down")
    .description("Stop and remove containers, keep volumes (compose down).")
    .option("--dir <path>", "Install directory")
    .action((opts: Record<string, unknown>) =>
      safe(() => down({ dir: opts["dir"] as string | undefined }))(),
    );

  /* ----------------------------- status ----------------------------- */
  program
    .command("status")
    .description("Show service state, port, version, and HTTP healthcheck.")
    .option("--dir <path>", "Install directory")
    .option("--json", "Output JSON for scripting")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        status({
          dir: opts["dir"] as string | undefined,
          json: Boolean(opts["json"]),
        }),
      )(),
    );

  /* ------------------------------ logs ------------------------------ */
  program
    .command("logs [service]")
    .description("Tail compose logs for one or all services.")
    .option("--dir <path>", "Install directory")
    .option("-f, --follow", "Follow log output")
    .addOption(
      new Option("--tail <n>", "Lines from the end")
        .default(200)
        .argParser(parsePositiveInt("--tail")),
    )
    .action((service: string | undefined, opts: Record<string, unknown>) =>
      safe(() =>
        logs(service, {
          dir: opts["dir"] as string | undefined,
          follow: Boolean(opts["follow"]),
          tail: opts["tail"] as number | undefined,
        }),
      )(),
    );

  /* ----------------------------- restart ---------------------------- */
  program
    .command("restart [service]")
    .description("Restart one or all services.")
    .option("--dir <path>", "Install directory")
    .option("--no-wait", "Don't wait for /api/auth/status")
    .action((service: string | undefined, opts: Record<string, unknown>) =>
      safe(() =>
        restart(service, {
          dir: opts["dir"] as string | undefined,
          noWait: opts["wait"] === false,
        }),
      )(),
    );

  /* ----------------------------- update ----------------------------- */
  program
    .command("update")
    .description("Pull latest images and recreate containers.")
    .option("--dir <path>", "Install directory")
    .option("--keep-compose", "Don't refresh bundled docker-compose.yml")
    .option("--no-wait", "Don't wait for /api/auth/status")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        update({
          dir: opts["dir"] as string | undefined,
          keepCompose: Boolean(opts["keepCompose"]),
          noWait: opts["wait"] === false,
        }),
      )(),
    );

  /* ---------------------------- uninstall --------------------------- */
  program
    .command("uninstall")
    .description("Remove containers + volumes + install dir (DESTRUCTIVE).")
    .option("--dir <path>", "Install directory")
    .option("--yes", "Skip confirmation")
    .option("--keep-dir", "Don't delete the install directory itself")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        uninstall({
          dir: opts["dir"] as string | undefined,
          yes: Boolean(opts["yes"]),
          keepDir: Boolean(opts["keepDir"]),
        }),
      )(),
    );

  /* ----------------------------- doctor ----------------------------- */
  program
    .command("doctor")
    .description("Diagnose docker/compose/disk/port/healthcheck issues.")
    .option("--dir <path>", "Install directory")
    .option("--json", "Output JSON for scripting")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        doctor({
          dir: opts["dir"] as string | undefined,
          json: Boolean(opts["json"]),
        }),
      )(),
    );

  /* ----------------------------- version ---------------------------- */
  // Note: commander has built-in -V/--version, but we want a richer command
  // that also reports Studio + Docker versions. The flag prints just the CLI
  // version; this subcommand prints the full report.
  program
    .command("version")
    .description("Print brikko-cli + Studio + Docker versions.")
    .option("--dir <path>", "Install directory")
    .option("--json", "Output JSON for scripting")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        versionCmd({
          dir: opts["dir"] as string | undefined,
          json: Boolean(opts["json"]),
        }),
      )(),
    );

  // Final error handler: commander writes its own help on unknown command.
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  log.err(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
