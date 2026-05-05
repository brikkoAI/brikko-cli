# brikko-cli

[![npm](https://img.shields.io/npm/v/brikko-cli.svg)](https://www.npmjs.com/package/brikko-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](#requirements)
[![CI](https://github.com/brikkoAI/brikko-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/brikkoAI/brikko-cli/actions)

Official CLI for [Brikko Studio](https://github.com/brikkoAI/brikko-studio) — the Russian-first desktop AI agent with reversible PII anonymization (152-FZ compliant).

[🇷🇺 Русский](#русский) · [🇬🇧 English](#english)

---

## Русский

`brikko-cli` — npm-пакет для установки, запуска и управления Brikko Studio. Заменяет `curl install.brikko.ru/studio.sh | bash` на привычный `npm i -g brikko-cli`.

### ⚡ Быстрый старт

```bash
npm install -g brikko-cli
brikko init
```

Откроется браузер на `http://localhost:3737`. Дальше — 6-шаговый онбординг Studio.

### 🛠 Требования

- **Node.js ≥ 18** (LTS) — `node --version`
- **Docker Desktop** или Docker Engine + Compose v2
  - macOS / Windows: [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  - Linux: `curl -fsSL https://get.docker.com | sudo sh`
- **2 GB свободного места** (под образы и workspace data)

CLI диагностирует все эти зависимости через `brikko doctor` и подсказывает что именно не так.

### 📋 Команды

| Команда | Что делает |
|---|---|
| `brikko init [--dir DIR] [--port N]` | Установка с нуля: проверки → compose.yml → pull → up → health → браузер |
| `brikko start` | Запустить сервисы (`docker compose up -d`) |
| `brikko stop` | Остановить контейнеры (данные сохраняются) |
| `brikko down` | Удалить контейнеры (volumes сохраняются) |
| `brikko status [--json]` | Состояние сервисов + healthcheck + версии |
| `brikko logs [service] [-f]` | Логи (всех или одного сервиса) |
| `brikko restart [service]` | Перезапуск |
| `brikko update` | Скачать новые образы и пересоздать контейнеры |
| `brikko uninstall [--yes]` | НЕОБРАТИМО: удалить контейнеры + volumes + папку |
| `brikko version [--json]` | Версии CLI / Studio / Docker |
| `brikko doctor [--json]` | Полная диагностика среды |

Все команды поддерживают `--help`. Глобальные флаги:

- `--dir <path>` — папка установки (по умолчанию `$HOME/brikko-studio`)
- `--json` — машинно-читаемый вывод для CI / скриптов
- `NO_COLOR=1` — отключить ANSI-цвета (стандарт [no-color.org](https://no-color.org))
- `BRIKKO_NO_BROWSER=1` — не открывать браузер после `brikko init`

### 🔍 Что делает `brikko init`

1. Определяет платформу (macOS / Linux / WSL / Windows)
2. Проверяет наличие `docker` + `docker compose` v2 + живой daemon (ждёт до 60 сек)
3. Создаёт `$HOME/brikko-studio/`
4. Раскладывает встроенные `docker-compose.yml` и `.env`
5. Проверяет что порт 3737 свободен (если нет — спрашивает другой)
6. `docker compose pull` (~600 MB первый раз)
7. `docker compose up -d`
8. Ждёт ответа от `http://127.0.0.1:3737/api/auth/status`
9. Открывает браузер

### 🆚 Почему npm CLI лучше чем `curl | bash`

| | curl-installer | npm CLI |
|---|---|---|
| Установка | `curl install.brikko.ru/studio.sh \| bash` | `npm i -g brikko-cli` |
| Обновления | `curl ... \| bash` заново | `brikko update` |
| Управление | руками `cd $DIR && docker compose ...` | `brikko start/stop/logs/...` |
| Версионирование | "latest", раскатка одновременная | `npm i -g brikko-cli@0.1.0` |
| Работа в РФ | зависит от CDN | npm registry стабилен |
| Диагностика | нет | `brikko doctor` |

Старый способ через `curl` всё ещё работает — оставлен как fallback для машин без Node.

### 🧪 Примеры

```bash
# Установка с нестандартным портом
brikko init --port 3838

# Установка без интерактивных вопросов (CI / scripted)
brikko init --yes --skip-pull --no-browser

# Обновление до новой версии Studio
npm i -g brikko-cli@latest && brikko update

# Логи только anonymizer-сервиса в реальном времени
brikko logs anonymizer --follow

# Машинно-читаемый статус для мониторинга
brikko status --json

# Полная диагностика
brikko doctor

# Полное удаление (необратимо)
brikko uninstall --yes
```

### 📁 Что хранится локально

```
$HOME/brikko-studio/
├── docker-compose.yml   ← bundled, перезаписывается при `brikko update`
└── .env                 ← BRIKKO_PORT, BRIKKO_VERSION (можно править руками)

Docker named volumes:
- brikko-state    ← workspace data, audit log, AES ключи
- brikko-config   ← пользовательские policy YAML
```

`brikko uninstall` удаляет всё. `brikko down` оставляет volumes.

### 🐛 Отчёты о багах

[github.com/brikkoAI/brikko-cli/issues](https://github.com/brikkoAI/brikko-cli/issues) или `hello@brikko.ru`.

---

## English

`brikko-cli` is the npm package that installs, runs, and manages [Brikko Studio](https://github.com/brikkoAI/brikko-studio). It replaces the legacy `curl install.brikko.ru/studio.sh | bash` flow with the standard `npm i -g brikko-cli`.

### ⚡ Quick start

```bash
npm install -g brikko-cli
brikko init
```

Your browser opens on `http://localhost:3737` for the 6-step Studio onboarding.

### 🛠 Requirements

- **Node.js ≥ 18** (LTS)
- **Docker Desktop** or Docker Engine + Compose v2
- **2 GB free disk** for images and workspace data

`brikko doctor` diagnoses all dependencies and prints actionable hints when something's missing.

### 📋 Commands

| Command | Description |
|---|---|
| `brikko init [--dir DIR] [--port N]` | Bootstrap: preflight → compose.yml → pull → up → health → browser |
| `brikko start` | Start services (`docker compose up -d`) |
| `brikko stop` | Stop containers (data preserved) |
| `brikko down` | Remove containers (volumes preserved) |
| `brikko status [--json]` | Service state + healthcheck + versions |
| `brikko logs [service] [-f]` | Tail logs (all services or one) |
| `brikko restart [service]` | Restart |
| `brikko update` | Pull new images and recreate containers |
| `brikko uninstall [--yes]` | DESTRUCTIVE: remove containers + volumes + dir |
| `brikko version [--json]` | CLI / Studio / Docker versions |
| `brikko doctor [--json]` | Full environment diagnostics |

Each command supports `--help`. Global flags:

- `--dir <path>` — install dir (default `$HOME/brikko-studio`)
- `--json` — machine-readable output
- `NO_COLOR=1` — disable ANSI colors ([no-color.org](https://no-color.org))
- `BRIKKO_NO_BROWSER=1` — don't open the browser after `brikko init`

### 🆚 Why npm CLI vs `curl | bash`

| | curl installer | npm CLI |
|---|---|---|
| Install | `curl install.brikko.ru/studio.sh \| bash` | `npm i -g brikko-cli` |
| Updates | re-run curl | `brikko update` |
| Management | manual `cd $DIR && docker compose ...` | `brikko start/stop/logs/...` |
| Versioning | floating | `npm i -g brikko-cli@0.1.0` |
| Diagnostics | none | `brikko doctor` |

The legacy `curl install.brikko.ru/studio.sh | bash` still works as a fallback for machines without Node.

### 🧪 Examples

```bash
# Install on a non-default port
brikko init --port 3838

# Non-interactive install (CI / scripted)
brikko init --yes --skip-pull --no-browser

# Upgrade to a new Studio version
npm i -g brikko-cli@latest && brikko update

# Tail anonymizer logs live
brikko logs anonymizer --follow

# Machine-readable status for monitoring
brikko status --json

# Full diagnostics
brikko doctor

# Wipe everything (irreversible)
brikko uninstall --yes
```

### 📁 Local layout

```
$HOME/brikko-studio/
├── docker-compose.yml   ← bundled, overwritten on `brikko update`
└── .env                 ← BRIKKO_PORT, BRIKKO_VERSION (hand-editable)

Docker named volumes:
- brikko-state    ← workspace data, audit log, AES keys
- brikko-config   ← user policy YAML
```

`brikko uninstall` removes everything. `brikko down` keeps volumes.

### 📜 Exit codes

- `0` — success
- `1` — error (preflight failed, command failed)
- `2` — user cancelled (Ctrl-C, declined prompt)

### 🤝 Contributing

```bash
git clone https://github.com/brikkoAI/brikko-cli
cd brikko-cli
npm install
npm test
npm run build
node ./dist/cli.js --help
```

PRs welcome. Tests via vitest, mocking execa to avoid real Docker calls.

### License

MIT — see [LICENSE](./LICENSE).

### Links

- Studio repo: [github.com/brikkoAI/brikko-studio](https://github.com/brikkoAI/brikko-studio)
- Website: [brikko.ru](https://brikko.ru)
- Telegram: [@brikko_news](https://t.me/brikko_news)
- Email: hello@brikko.ru
