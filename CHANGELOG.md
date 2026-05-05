# Changelog

All notable changes to `brikko-cli` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-05-05

Initial public release. Replaces the legacy `curl install.brikko.ru/studio.sh | bash` installer with a proper npm CLI.

### Added

- `brikko init` — full bootstrap: preflight, port collision handling, compose pull, up -d, healthcheck wait, browser open. Idempotent — safe to re-run.
- `brikko start` / `brikko stop` / `brikko down` — basic lifecycle controls.
- `brikko status [--json]` — per-service state + HTTP healthcheck + version.
- `brikko logs [service] [--follow] [--tail N]` — pass-through to `docker compose logs` with SIGINT forwarding.
- `brikko restart [service]` — restart all or one service, optionally wait for `/api/auth/status`.
- `brikko update` — refresh bundled `docker-compose.yml`, pull latest images, re-up.
- `brikko uninstall [--yes] [--keep-dir]` — destructive removal of containers + volumes + install dir, with confirmation prompt.
- `brikko version [--json]` — CLI version + Studio version (live from `/api/version`) + Docker / Compose versions.
- `brikko doctor [--json]` — full environment diagnostic table: docker, daemon, compose v2, install dir, .env, compose.yml, port availability, free disk, HTTP healthcheck.
- `--json` output mode for `status`, `version`, `doctor` for CI / monitoring scripts.
- `NO_COLOR=1` and `BRIKKO_NO_BROWSER=1` env-var support.
- Bundled `docker-compose.yml` and `.env.example` (versioned with the CLI; no runtime download required, removes RF-blocked CDN dependency).
- Per-platform error hints (macOS / Linux / WSL / Windows) for Docker missing, daemon down, Compose v2 missing — matches `install.sh` behaviour.

### Notes

- Targets Node ≥ 18. Tested on Node 18 / 20 / 22 in CI.
- Bundle size: ~ 50 KB self code + dependencies (commander, execa, ora, picocolors, prompts).
- The legacy `curl install.brikko.ru/studio.sh | bash` installer in the [brikko-studio](https://github.com/brikkoAI/brikko-studio) repo is preserved as a fallback for machines without Node.

[0.1.0]: https://github.com/brikkoAI/brikko-cli/releases/tag/v0.1.0
