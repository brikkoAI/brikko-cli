/**
 * `brikko restore --mapping-id <ID>` — restore PII placeholders to real values.
 *
 * Always prints plain text to stdout (callers usually want to pipe it on).
 *
 * Input: `--text "..."` flag, or stdin if piped.
 */

import { resolveAuth, AuthError } from "../lib/auth.js";
import { BrikkoApiClient, ApiError, NetworkError } from "../lib/api.js";
import { readStdin } from "../lib/stdin.js";
import { log } from "../lib/logger.js";

export interface RestoreOptions {
  mappingId?: string | undefined;
  text?: string | undefined;
  key?: string | undefined;
}

export async function restore(opts: RestoreOptions): Promise<number> {
  if (!opts.mappingId) {
    log.err("Не указан --mapping-id.");
    log.hint("Получи mapping_id из ответа brikko anonymize.");
    return 1;
  }
  let text = opts.text ?? "";
  if (!text && !process.stdin.isTTY) text = await readStdin();
  if (!text.trim()) {
    log.err("Пустой текст. Передай через --text или stdin.");
    return 1;
  }

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
    const res = await client.restore(text, opts.mappingId, ctrl.signal);
    process.stdout.write(
      res.restored_text + (res.restored_text.endsWith("\n") ? "" : "\n"),
    );
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
