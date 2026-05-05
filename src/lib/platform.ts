/**
 * Platform detection + browser-open helpers.
 *
 * Distinguishes WSL from native Linux because Docker Desktop / WSL Integration
 * has unique failure modes worth surfacing in error messages. Mirrors the
 * detection in install.sh so the CLI gives the same hints as the legacy
 * `curl | bash` installer.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

export type Platform = "macos" | "linux" | "wsl" | "windows" | "unknown";

/**
 * Detect the current platform. Reads /proc/version to distinguish WSL.
 * Returns "unknown" on exotic systems (e.g. AIX, BSD); callers should
 * gracefully degrade by skipping platform-specific hints.
 */
export async function detectPlatform(): Promise<Platform> {
  const p = process.platform;
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  if (p === "linux") {
    if (existsSync("/proc/version")) {
      try {
        const content = await readFile("/proc/version", "utf8");
        if (/microsoft|wsl/i.test(content)) return "wsl";
      } catch {
        /* fall through to linux */
      }
    }
    return "linux";
  }
  return "unknown";
}

/**
 * Open a URL in the user's default browser. Best-effort: returns false if no
 * known opener works. Never throws — failure to open the browser is not a
 * fatal error; user can navigate manually.
 *
 * On WSL we shell out to cmd.exe to launch the host-side browser, since
 * Linux GUI apps inside WSL don't trigger the user's normal Chrome/Firefox.
 */
export async function openBrowser(url: string, platform: Platform): Promise<boolean> {
  // Honor BRIKKO_NO_BROWSER for headless setups + CI.
  if (process.env["BRIKKO_NO_BROWSER"] === "1") return false;

  const cmd = browserCommand(url, platform);
  if (!cmd) return false;

  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.command, cmd.args, {
        detached: true,
        stdio: "ignore",
        shell: cmd.shell ?? false,
      });
      child.on("error", () => resolve(false));
      child.unref();
      // We only confirm spawn — actual browser launch is async and we don't
      // want to block on it. If spawn fails, child.on('error') resolves false.
      setTimeout(() => resolve(true), 100);
    } catch {
      resolve(false);
    }
  });
}

interface BrowserCommand {
  command: string;
  args: string[];
  shell?: boolean;
}

function browserCommand(url: string, platform: Platform): BrowserCommand | null {
  switch (platform) {
    case "macos":
      return { command: "open", args: [url] };
    case "linux":
      return { command: "xdg-open", args: [url] };
    case "wsl":
      // cmd.exe needs `start "" url`; use shell:true so quoting works.
      return { command: `cmd.exe /C start "" "${url}"`, args: [], shell: true };
    case "windows":
      // start is a cmd.exe builtin, not a standalone exe.
      return { command: `start "" "${url}"`, args: [], shell: true };
    default:
      return null;
  }
}

/**
 * Human-friendly platform name for logs.
 */
export function platformLabel(p: Platform): string {
  switch (p) {
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "wsl":
      return "WSL (Linux on Windows)";
    case "windows":
      return "Windows";
    case "unknown":
      return "unknown";
  }
}
