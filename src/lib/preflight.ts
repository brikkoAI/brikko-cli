/**
 * Pre-flight checks shared by `init`, `start`, `update`, `doctor`.
 *
 * Returns structured findings rather than calling process.exit — so callers
 * (and the JSON output mode of `doctor`) can format them as they wish.
 */

import {
  hasDocker,
  hasComposeV2,
  dockerDaemonAlive,
  waitForDaemon,
  dockerVersion,
  composeVersion,
} from "./docker.js";
import { detectPlatform, type Platform } from "./platform.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  level: CheckLevel;
  message: string;
  hint?: string;
  detail?: string;
}

export interface PreflightOptions {
  /** Wait up to this long for daemon to come up. 0 = no wait. */
  daemonWaitMs?: number;
}

/**
 * Run the standard install/start preflight: docker present, compose v2
 * present, daemon alive. Each missing/broken check is a `fail`. Caller
 * should bail if any `fail` is present.
 */
export async function runPreflight(opts: PreflightOptions = {}): Promise<CheckResult[]> {
  const platform = await detectPlatform();
  const out: CheckResult[] = [];

  // 1. docker binary
  if (!(await hasDocker())) {
    out.push({
      id: "docker-missing",
      level: "fail",
      message: "Docker не найден (docker --version упал)",
      hint: dockerInstallHint(platform),
    });
    // Without docker, all other checks are moot.
    return out;
  }
  const dv = await dockerVersion();
  out.push({
    id: "docker-installed",
    level: "ok",
    message: dv ?? "docker available",
  });

  // 2. compose v2
  if (!(await hasComposeV2())) {
    out.push({
      id: "compose-missing",
      level: "fail",
      message: "Docker Compose v2 не найден (docker compose version упал)",
      hint: composeInstallHint(platform),
    });
  } else {
    const cv = await composeVersion();
    out.push({
      id: "compose-installed",
      level: "ok",
      message: `Compose ${cv ?? "v2"}`,
    });
  }

  // 3. daemon alive (optionally wait)
  let alive = await dockerDaemonAlive();
  if (!alive && (opts.daemonWaitMs ?? 0) > 0) {
    alive = await waitForDaemon(opts.daemonWaitMs!);
  }
  if (!alive) {
    out.push({
      id: "daemon-down",
      level: "fail",
      message: "Docker daemon не отвечает",
      hint: daemonStartHint(platform),
    });
  } else {
    out.push({
      id: "daemon-alive",
      level: "ok",
      message: "Docker daemon отвечает",
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Per-OS hints (Russian, matching install.sh tone)                            */
/* -------------------------------------------------------------------------- */

export function dockerInstallHint(p: Platform): string {
  switch (p) {
    case "macos":
      return "Поставь Docker Desktop: https://www.docker.com/products/docker-desktop/";
    case "wsl":
    case "windows":
      return "Поставь Docker Desktop для Windows: https://www.docker.com/products/docker-desktop/ — после установки в Settings → Resources → WSL Integration включи свой дистрибутив.";
    case "linux":
      return "Ubuntu/Debian: curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker";
    default:
      return "Установи Docker и Compose v2 для своей платформы.";
  }
}

export function composeInstallHint(p: Platform): string {
  switch (p) {
    case "linux":
      return "Поставь docker-compose-plugin: sudo apt-get install docker-compose-plugin (Debian/Ubuntu) или sudo dnf install docker-compose-plugin (Fedora/RHEL)";
    default:
      return "Обнови Docker Desktop до последней версии — Compose v2 встроен.";
  }
}

export function daemonStartHint(p: Platform): string {
  switch (p) {
    case "macos":
      return "Открой Docker Desktop (Applications → Docker), дождись когда whale-icon в menu-bar перестанет анимироваться, затем повтори команду.";
    case "wsl":
      return "На Windows открой Docker Desktop, дождись зелёного кита в трее, в Settings → Resources → WSL Integration включи свой дистрибутив, перезапусти терминал WSL.";
    case "windows":
      return "Открой Docker Desktop через меню «Пуск», дождись зелёного кита в трее, повтори команду.";
    case "linux":
      return "sudo systemctl start docker && sudo systemctl enable docker. Если не в группе docker: sudo usermod -aG docker $USER && newgrp docker";
    default:
      return "Запусти Docker daemon и повтори команду.";
  }
}
