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
import { chat } from "./commands/chat.js";
import { anonymize } from "./commands/anonymize.js";
import { restore } from "./commands/restore.js";
import { safeChat } from "./commands/safeChat.js";
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

  /* ------------------------------ chat ------------------------------ */
  program
    .command("chat [prompt]")
    .description(
      "Send a chat completion to api.brikko.ru. Use '-' or pipe stdin to read the prompt.",
    )
    .option("--prompt <text>", "User prompt (alternative to positional arg, pairs with --system)")
    .option("--system <text>", "System message")
    .option(
      "-m, --model <id>",
      "Model id (e.g. auto:cheap, auto:smart, gpt-5.4-mini). Default: auto:cheap",
    )
    .option("--json", "Output the full JSON response instead of just the text")
    .option("--stream", "Stream tokens as they arrive (SSE)")
    .option("--key <apiKey>", "Override API key (skip env / config file)")
    .option(
      "--temperature <n>",
      "Sampling temperature (0..2)",
      (v: string) => Number.parseFloat(v),
    )
    .option(
      "--max-tokens <n>",
      "Maximum tokens in the completion",
      parsePositiveInt("--max-tokens"),
    )
    .action((promptArg: string | undefined, opts: Record<string, unknown>) =>
      safe(() =>
        chat({
          prompt: promptArg,
          promptFlag: opts["prompt"] as string | undefined,
          system: opts["system"] as string | undefined,
          model: opts["model"] as string | undefined,
          json: Boolean(opts["json"]),
          stream: Boolean(opts["stream"]),
          key: opts["key"] as string | undefined,
          temperature: opts["temperature"] as number | undefined,
          maxTokens: opts["maxTokens"] as number | undefined,
        }),
      )(),
    );

  /* ----------------------------- anonymize -------------------------- */
  program
    .command("anonymize")
    .description(
      "Mask PII in text via /v1/anonymize. Reads from --text or stdin. JSON to stdout (--pretty for human view).",
    )
    .option("--text <text>", "Text to mask (otherwise stdin)")
    .option("--pretty", "Human-readable output instead of JSON")
    .option("--key <apiKey>", "Override API key")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        anonymize({
          text: opts["text"] as string | undefined,
          pretty: Boolean(opts["pretty"]),
          key: opts["key"] as string | undefined,
        }),
      )(),
    );

  /* ----------------------------- restore ---------------------------- */
  program
    .command("restore")
    .description(
      "Restore PII placeholders to real values via /v1/restore. Plain text to stdout.",
    )
    .requiredOption(
      "--mapping-id <id>",
      "Mapping ID returned by /v1/anonymize",
    )
    .option("--text <text>", "Text to restore (otherwise stdin)")
    .option("--key <apiKey>", "Override API key")
    .action((opts: Record<string, unknown>) =>
      safe(() =>
        restore({
          mappingId: opts["mappingId"] as string | undefined,
          text: opts["text"] as string | undefined,
          key: opts["key"] as string | undefined,
        }),
      )(),
    );

  /* ---------------------------- safe-chat --------------------------- */
  program
    .command("safe-chat [prompt]")
    .description(
      "Privacy-safe chat: anonymize PII, send to chat, then restore the answer (152-FZ).",
    )
    .option("--prompt <text>", "User prompt (alternative to positional arg)")
    .option("--system <text>", "System message")
    .option(
      "-m, --model <id>",
      "Model id (default: auto:cheap)",
    )
    .option("--json", "Output the full pipeline trace as JSON")
    .option("--key <apiKey>", "Override API key")
    .option("--verbose", "Log how many PII spans were found (stderr)")
    .action((promptArg: string | undefined, opts: Record<string, unknown>) =>
      safe(() =>
        safeChat({
          prompt: promptArg,
          promptFlag: opts["prompt"] as string | undefined,
          system: opts["system"] as string | undefined,
          model: opts["model"] as string | undefined,
          json: Boolean(opts["json"]),
          key: opts["key"] as string | undefined,
          verbose: Boolean(opts["verbose"]),
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
