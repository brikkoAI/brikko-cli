# brikko-cli

[![npm version](https://img.shields.io/npm/v/brikko-cli.svg)](https://www.npmjs.com/package/brikko-cli)
[![npm downloads](https://img.shields.io/npm/dm/brikko-cli.svg)](https://www.npmjs.com/package/brikko-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](#requirements)
[![GitHub stars](https://img.shields.io/github/stars/brikkoAI/brikko-cli?style=social)](https://github.com/brikkoAI/brikko-cli/stargazers)
[![CI](https://github.com/brikkoAI/brikko-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/brikkoAI/brikko-cli/actions)

> **Часть [Brikko Privacy Ecosystem](https://brikko.ru)** — open-source инфраструктура маскинга персональных данных перед AI для русского рынка.

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

**API-команды (v0.2.0+):** не требуют Studio, общаются прямо с `api.brikko.ru`.

| Команда | Что делает |
|---|---|
| `brikko chat [prompt]` | Чат с LLM через смарт-рутер. `--stream`, `--system`, `--json`, `--model auto:smart` |
| `brikko anonymize [--text "..."]` | Маскирование PII (стдин или `--text`). По default JSON, `--pretty` для человека |
| `brikko restore --mapping-id ID` | Восстановление PII placeholders → реальный текст |
| `brikko safe-chat [prompt]` | **anonymize → chat → restore** одной командой. Compliance-friendly (152-ФЗ) |

**Прокси-команды (v0.3.0+):** локальный OpenAI-совместимый прокси с автоматическим PII-маскингом.

| Команда | Что делает |
|---|---|
| `brikko proxy start [--port N] [--no-pii-protect]` | Запустить демон на `http://127.0.0.1:11434`. Любой OpenAI SDK можно нацелить сюда — Brikko прозрачно проксирует, считает токены, маскирует ПД |
| `brikko proxy stop` | Остановить демон (SIGTERM, через 5 сек SIGKILL) |
| `brikko proxy status [--json]` | Состояние + uptime + счётчики (запросы, маски, ошибки) |
| `brikko proxy logs [-f] [--tail N]` | Хвост `~/.brikko/proxy.log` (NDJSON) |

**Studio-команды:** для управления локальным агентом.

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

- `--dir <path>` — папка установки Studio (по умолчанию `$HOME/brikko-studio`)
- `--json` — машинно-читаемый вывод для CI / скриптов
- `NO_COLOR=1` — отключить ANSI-цвета (стандарт [no-color.org](https://no-color.org))
- `BRIKKO_NO_BROWSER=1` — не открывать браузер после `brikko init`

API-команды (`chat`, `anonymize`, `restore`, `safe-chat`) дополнительно используют:

- `BRIKKO_API_KEY` — твой ключ `sk-brk-…` (получи на [brikko.ru/app/keys](https://brikko.ru/app/keys))
- `--key <apiKey>` — override ключа на одну команду
- `BRIKKO_API_BASE` — override gateway URL (`https://api.brikko.ru` по default)
- `~/.brikko/config.json` — место, где CLI кеширует ключ после первого ввода

### 🤖 Чат с LLM из терминала

```bash
# Первый запуск спросит API ключ и сохранит в ~/.brikko/config.json
brikko chat "Объясни TLS handshake простыми словами"

# Стриминг токен за токеном (как ChatGPT в браузере)
brikko chat "Напиши rate-limiter на Go" --stream

# Конкретная модель + system message
brikko chat --system "Отвечай только на русском, в 3 предложения" \
            --prompt "Что такое OAuth 2.1?"

# Из stdin (для пайпов)
cat README.md | brikko chat "Сделай TL;DR в 3 пунктах" --stream

# JSON для скриптов
brikko chat "..." --json | jq -r '.choices[0].message.content'
```

### 🛡 PII-маскирование (152-ФЗ)

```bash
# Маскирование
echo "ИНН 7707083893, Иванов Иван" | brikko anonymize
# → {"masked_text":"ИНН <INN_1>, <NAME_1>","mapping_id":"ab12...","count":2}

# Восстановление по mapping_id
echo "<NAME_1> подтвердил ИНН <INN_1>" \
  | brikko restore --mapping-id ab12...
# → Иванов Иван подтвердил ИНН 7707083893

# Безопасный chat одной командой (anonymize → chat → restore)
echo "Письмо клиенту Иванову с ИНН 7707083893" | brikko safe-chat
# Модель видит "<NAME_1>" и "<INN_1>", ответ возвращается с реальными ПД.
```

### 🔁 Локальный прокси для OpenAI SDK

`brikko proxy` поднимает локальный демон, прикидывающийся `api.openai.com`.
Существующий код, написанный под OpenAI SDK, начинает работать через Brikko
без единой строчки правок — просто меняем `OPENAI_BASE_URL`.

```bash
# Запустить демон (автоматический PII-masking для /v1/chat и /v1/embeddings)
brikko proxy start
# → Прокси работает на http://127.0.0.1:11434 (PID 12345)

# Использование с OpenAI SDK (Python)
export OPENAI_BASE_URL=http://127.0.0.1:11434/v1
export OPENAI_API_KEY=anything   # реальный ключ Brikko уже в демоне
python my_existing_openai_app.py

# Аналогично с Node.js / curl / любым другим клиентом
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto:cheap","messages":[{"role":"user","content":"hi"}]}'

# Состояние + статистика
brikko proxy status
# → uptime: 5m, requests: 17, masks: 12, errors: 0

# Лог запросов (NDJSON, по одному JSON-объекту на строку)
brikko proxy logs --tail 50

# Хвост логов в реальном времени
brikko proxy logs -f

# Остановить
brikko proxy stop
```

**Что прокси делает автоматически (если PII-protection включена):**

1. На `/v1/chat/completions` и `/v1/embeddings` — текст из `messages[].content` /
   `input` уходит сначала в `/v1/anonymize`, ПД заменяются плейсхолдерами,
   только потом запрос идёт в LLM.
2. Ответ от LLM проходит через `/v1/restore` — клиент получает уже реальные
   ИНН / ФИО / телефоны вместо `<INN_1>` / `<NAME_1>`.
3. Для streaming (SSE) ответ проходит к клиенту с плейсхолдерами (низкий TTFT),
   а в конце потока эмитится дополнительное событие `event: brikko.restored`
   с уже восстановленным текстом — Brikko-aware клиенты могут подменить DOM.

**Известные ограничения V0.3:**

- Один демон на пользователя. Multi-port появится в V0.4.
- `/v1/audio/transcriptions` (Whisper) — тоже проксируется, но без PII-маскинга
  на лету (multipart/audio binary). Транскрипты можно прогнать через
  `brikko anonymize` отдельно.
- WebSockets / `Connection: Upgrade` не поддерживаются (отвечает `501`).
- Демон биндится только на `127.0.0.1` — нельзя случайно открыть его наружу
  и засветить ключ в локальной сети.

**Опции:**

- `--port N` — слушать другой порт (default `11434`)
- `--no-pii-protect` — отключить anonymize/restore (raw pass-through)
- `--foreground` — не форкать, держать процесс в текущей оболочке (отладка)
- `--force` — убить существующий демон перед запуском

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

---

## 🔗 Связанные продукты Brikko

| Артефакт | Установка | Аудитория |
|---|---|---|
| [brikko-studio](https://github.com/brikkoAI/brikko-studio) | `curl install.brikko.ru/studio.sh \| bash` | Desktop AI agent с MCP |
| [brikko-shield](https://github.com/brikkoAI/brikko-shield) | Chrome Web Store (скоро) | Маскинг в ChatGPT/Claude.ai |
| **brikko-cli** ★ (вы здесь) | `npm install -g brikko-cli` | CLI для Studio |
| [brikko-pii-skill](https://github.com/brikkoAI/brikko-pii-skill) | `git clone` | Skill для Claude Code/Cursor |
| [n8n-nodes-brikko](https://github.com/brikkoAI/n8n-nodes-brikko) | `npm install n8n-nodes-brikko` | Маскинг в n8n workflows |
| [presidio-ru-recognizers](https://github.com/brikkoAI/presidio-ru-recognizers) | `pip install presidio-ru-recognizers` | Python recognizers для Presidio |
