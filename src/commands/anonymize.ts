/**
 * `brikko anonymize` — mask PII in text via POST /v1/anonymize.
 *
 * Default: JSON to stdout (pipe-friendly: `… | jq .masked_text`).
 * `--pretty`: human-readable two-block summary.
 *
 * Input: `--text "..."` flag, or stdin if piped.
 */

import pc from "picocolors";
import { resolveAuth, AuthError } from "../lib/auth.js";
import { BrikkoApiClient, ApiError, NetworkError } from "../lib/api.js";
import { readStdin } from "../lib/stdin.js";
import { log } from "../lib/logger.js";

export interface AnonymizeOptions {
  text?: string | undefined;
  pretty?: boolean | undefined;
  key?: string | undefined;
}

export async function anonymize(opts: AnonymizeOptions): Promise<number> {
  let text = opts.text ?? "";
  if (!text && !process.stdin.isTTY) text = (await readStdin()).trim();
  if (!text) {
    log.err("Пустой текст. Передай через --text или stdin.");
    log.hint('Пример: echo "ИНН 7707083893" | brikko anonymize');
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
    const res = await client.anonymize(text, ctrl.signal);
    if (opts.pretty) {
      process.stdout.write(`${pc.bold("Masked:")}\n${res.masked_text}\n\n`);
      process.stdout.write(
        `${pc.dim("mapping_id:")} ${res.mapping_id}\n${pc.dim("count:")} ${res.count}\n`,
      );
      if (res.expires_at_unix) {
        const iso = new Date(res.expires_at_unix * 1000).toISOString();
        process.stdout.write(`${pc.dim("expires:")} ${iso}\n`);
      }
    } else {
      process.stdout.write(JSON.stringify(res) + "\n");
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
