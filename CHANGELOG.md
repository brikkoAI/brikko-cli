# Changelog

All notable changes to `brikko-cli` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] — 2026-05-06

Adds `brikko proxy` — a local OpenAI-compatible HTTP proxy to `api.brikko.ru`
with **transparent PII masking**. The killer feature: any existing app written
against the OpenAI SDK can switch to Brikko by changing **one env var**
(`OPENAI_BASE_URL=http://127.0.0.1:11434/v1`), with no code changes —
and gets 152-FZ-clean traffic out of the box.

### Added

- `brikko proxy start [--port N] [--no-pii-protect] [--foreground] [--force]` —
  spawn a detached daemon listening on `127.0.0.1:11434` (default).
  Forwards all `/v1/*` routes to `api.brikko.ru` with the user's API key
  injected server-side; client-supplied `Authorization` is stripped (so the
  app code can keep `OPENAI_API_KEY=anything`).
- `brikko proxy stop` — graceful SIGTERM with 5-second SIGKILL fallback.
- `brikko proxy status [--json]` — uptime, port, PID, request counters,
  upstream healthcheck.
- `brikko proxy logs [-f] [--tail N]` — tail the NDJSON request log at
  `~/.brikko/proxy.log`.
- **Automatic PII pipeline** (default-on) for `/v1/chat/completions` and
  `/v1/embeddings`: anonymize → forward → restore. Streaming (SSE) keeps
  low TTFT by piping placeholders to the client and emitting one final
  `event: brikko.restored` SSE event with the unmasked text.
- `/healthz` always returns `200` even when upstream is down — useful for
  uptime probes that need to distinguish "daemon dead" from "internet flaky".
- `/__brikko/stats` admin endpoint with the full counter snapshot.
- One-process-per-user invariant: starting twice without `--force` fails
  loudly (avoids double-binding the port and orphaning the old daemon).
- 25 new unit tests (counters, PID-file lifecycle, server end-to-end with
  mocked upstream).

### Notes

- Daemon binds to `127.0.0.1` only — no LAN exposure. Bind to `0.0.0.0`
  is intentionally not supported in V0.3 (would expose the user's API key
  to anyone on the network).
- WebSockets / `Connection: Upgrade` requests return `501 Not Implemented`.
- Multi-instance / multi-port support is V0.4. V0.3 stores a single
  PID at `~/.brikko/proxy.pid`.
- `/v1/audio/transcriptions` is proxied transparently but **not**
  PII-masked on the fly (multipart audio binary). Run the resulting
  transcript through `brikko anonymize` if needed.
- No new runtime dependencies. Bundle stays under ~80 KB.

[0.3.0]: https://github.com/brikkoAI/brikko-cli/releases/tag/v0.3.0

## [0.2.0] — 2026-05-06

Adds first-class API commands so the CLI is useful even without a local Studio install: chat with any model on the Brikko gateway and mask/restore PII straight from the terminal.

### Added

- `brikko chat [prompt]` — send a chat completion to `api.brikko.ru/v1/chat/completions`. Supports `--system`, `--model`, `--json`, `--stream` (SSE token-by-token), `--temperature`, `--max-tokens`. Reads stdin when prompt is `-` or piped. Default model: `auto:cheap` (cost-optimised by smart router).
- `brikko anonymize [--text TEXT] [--pretty]` — mask PII via `/v1/anonymize`. JSON to stdout by default (pipe-friendly), `--pretty` for human view.
- `brikko restore --mapping-id <id>` — restore PII placeholders via `/v1/restore`. Plain text to stdout.
- `brikko safe-chat [prompt]` — **the killer compliance flow**: anonymize → chat → restore in one shot. No raw PII ever leaves the gateway boundary; the answer comes back with real values restored. `--json` emits the full pipeline trace.
- `~/.brikko/config.json` — user-level config storing the API key. Auth resolution: `--key` flag → `BRIKKO_API_KEY` env → file → interactive prompt (TTY only). On POSIX the file is `chmod 0600`.
- `BRIKKO_API_BASE` env var to override the gateway URL (legacy `BRIKKO_GATEWAY` still honoured).
- Exponential-backoff retry (3x, 200/400/800 ms) on network errors and 5xx responses. 4xx errors fail fast with friendly hints (401 → check key, 402 → top up balance).
- Ctrl-C cleanly aborts in-flight requests via `AbortController`; exits with code 2.

### Notes

- Existing 11 commands (`init`, `start`, `stop`, `down`, `status`, `logs`, `restart`, `update`, `uninstall`, `doctor`, `version`) are untouched and backward-compatible.
- Bundle stays well under 250 KB; no new runtime dependencies (uses Node 18+ global `fetch` and `AbortController`).

[0.2.0]: https://github.com/brikkoAI/brikko-cli/releases/tag/v0.2.0

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

