/**
 * `brikko safe-chat <prompt>` — anonymize → chat → restore, in one shot.
 *
 * The flow:
 *   1. POST /v1/anonymize with the user's prompt → masked_text + mapping_id.
 *      A `<NAME_1>` style placeholder replaces every PII span we detected.
 *   2. POST /v1/chat/completions with the masked prompt.
 *   3. POST /v1/restore on the assistant text with the same mapping_id.
 *      Idempotent: if the assistant didn't use any placeholder, the text
 *      passes through unchanged. If the gateway ALSO did server-side restore
 *      (pii-protect=true), placeholders that are already real values just
 *      stay real values — restoring an absent placeholder is a no-op.
 *
 * Why this matters: a single command gives a 152-FZ-clean roundtrip
 * (no raw PII ever crosses the model boundary) while preserving the
 * user's mental model of "I sent X, I got Y back".
 *
 * Output: plain text to stdout (or `--json` for the full pipeline trace).
 */

import { resolveAuth, AuthError } from "../lib/auth.js";
import {
  BrikkoApiClient,
  ApiError,
  NetworkError,
  extractCompletionText,
  type ChatMessage,
} from "../lib/api.js";
import { readStdin } from "../lib/stdin.js";
import { log } from "../lib/logger.js";

export interface SafeChatOptions {
  prompt?: string | undefined;
  promptFlag?: string | undefined;
  system?: string | undefined;
  model?: string | undefined;
  json?: boolean | undefined;
  key?: string | undefined;
  /** When true, also print which placeholders were used (stderr). */
  verbose?: boolean | undefined;
}

const DEFAULT_MODEL = "auto:cheap";

export async function safeChat(opts: SafeChatOptions): Promise<number> {
  // ── 1. resolve user prompt
  let userPrompt = opts.promptFlag ?? opts.prompt ?? "";
  if (userPrompt === "-" || (!userPrompt && !process.stdin.isTTY)) {
    userPrompt = (await readStdin()).trim();
  }
  if (!userPrompt) {
    log.err("Пустой prompt. Передай аргументом, через --prompt, или через stdin.");
    return 1;
  }

  // ── 2. resolve auth
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

  const client = new BrikkoApiClient({ apiKey: auth.apiKey, apiBase: auth.apiBase });
  const ctrl = new AbortController();
  const onSigint = (): void => ctrl.abort(new Error("SIGINT"));
  process.on("SIGINT", onSigint);

  try {
    // ── 3. anonymize
    const anon = await client.anonymize(userPrompt, ctrl.signal);
    if (opts.verbose) {
      log.info(`PII-замен: ${anon.count}, mapping_id=${anon.mapping_id}`);
    }

    // ── 4. chat
    const messages: ChatMessage[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    messages.push({ role: "user", content: anon.masked_text });

    const chatRes = await client.chatCompletion(
      { model: opts.model ?? DEFAULT_MODEL, messages },
      ctrl.signal,
    );
    const assistantMasked = extractCompletionText(chatRes);

    // ── 5. restore (idempotent — safe even if there are no placeholders)
    let assistantFinal = assistantMasked;
    if (anon.count > 0 && assistantMasked) {
      const restored = await client.restore(
        assistantMasked,
        anon.mapping_id,
        ctrl.signal,
      );
      assistantFinal = restored.restored_text;
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            masked_prompt: anon.masked_text,
            mapping_id: anon.mapping_id,
            pii_count: anon.count,
            assistant_masked: assistantMasked,
            assistant_final: assistantFinal,
            usage: chatRes.usage ?? null,
            model: chatRes.model ?? opts.model ?? DEFAULT_MODEL,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(
        assistantFinal + (assistantFinal.endsWith("\n") ? "" : "\n"),
      );
    }
    return 0;
  } catch (e) {
    if (ctrl.signal.aborted) {
      log.warn("Прервано (Ctrl-C).");
      return 2;
    }
    if (e instanceof ApiError) {
      log.err(e.message);
      return 1;
    }
    if (e instanceof NetworkError) {
      log.err(`Сеть недоступна: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
