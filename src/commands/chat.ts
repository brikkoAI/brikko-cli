/**
 * `brikko chat <prompt>` — send a chat completion to api.brikko.ru.
 *
 * Modes:
 *   --json     → write the raw JSON response to stdout (pipeable)
 *   --stream   → token-by-token SSE, written to stdout as it arrives
 *   default    → print the assistant text to stdout, no decoration
 *
 * Auth resolution (via lib/auth):
 *   --key flag > BRIKKO_API_KEY env > ~/.brikko/config.json > prompt (TTY only)
 *
 * Ctrl-C cleanly aborts the in-flight request via AbortController.
 */

import { resolveAuth, AuthError } from "../lib/auth.js";
import {
  BrikkoApiClient,
  ApiError,
  NetworkError,
  extractStreamDelta,
  extractCompletionText,
  type ChatMessage,
} from "../lib/api.js";
import { readStdin } from "../lib/stdin.js";
import { log } from "../lib/logger.js";

export interface ChatOptions {
  /** Positional prompt argument; "-" means read from stdin. */
  prompt?: string | undefined;
  /** Alternate way to pass user prompt (paired with --system). */
  promptFlag?: string | undefined;
  system?: string | undefined;
  model?: string | undefined;
  json?: boolean | undefined;
  stream?: boolean | undefined;
  key?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

const DEFAULT_MODEL = "auto:cheap";

export async function chat(opts: ChatOptions): Promise<number> {
  // ── 1. Resolve the user prompt
  let userPrompt = opts.promptFlag ?? opts.prompt ?? "";
  if (userPrompt === "-" || (!userPrompt && !process.stdin.isTTY)) {
    userPrompt = (await readStdin()).trim();
  }
  if (!userPrompt && !opts.system) {
    log.err("Пустой prompt. Передай аргументом, через --prompt, или через stdin.");
    log.hint('Пример: brikko chat "Привет"  или  echo "..." | brikko chat -');
    return 1;
  }

  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  if (userPrompt) messages.push({ role: "user", content: userPrompt });

  // ── 2. Resolve auth
  let auth;
  try {
    auth = await resolveAuth({ key: opts.key, interactive: true });
  } catch (e) {
    if (e instanceof AuthError) {
      log.err(e.message);
      return 1;
    }
    throw e;
  }

  // ── 3. Build client + abort handling
  const client = new BrikkoApiClient({ apiKey: auth.apiKey, apiBase: auth.apiBase });
  const ctrl = new AbortController();
  const onSigint = (): void => {
    ctrl.abort(new Error("SIGINT"));
  };
  process.on("SIGINT", onSigint);

  const model = opts.model ?? DEFAULT_MODEL;
  try {
    if (opts.stream) {
      // Streaming: write deltas straight to stdout.
      let any = false;
      for await (const chunk of client.chatCompletionStream(
        {
          model,
          messages,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        },
        ctrl.signal,
      )) {
        const delta = extractStreamDelta(chunk);
        if (delta) {
          process.stdout.write(delta);
          any = true;
        }
      }
      if (any) process.stdout.write("\n");
      return 0;
    }

    const res = await client.chatCompletion(
      {
        model,
        messages,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      },
      ctrl.signal,
    );

    if (opts.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else {
      const text = extractCompletionText(res);
      process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    }
    return 0;
  } catch (e) {
    if (ctrl.signal.aborted) {
      // User Ctrl-C — exit code 2 per project convention.
      log.warn("Прервано (Ctrl-C).");
      return 2;
    }
    if (e instanceof ApiError) {
      log.err(e.message);
      return 1;
    }
    if (e instanceof NetworkError) {
      log.err(`Сеть недоступна: ${e.message}`);
      log.hint("Проверь подключение к https://api.brikko.ru или попробуй позже.");
      return 1;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
