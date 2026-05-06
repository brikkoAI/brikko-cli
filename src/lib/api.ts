/**
 * Thin HTTP client for api.brikko.ru.
 *
 * Endpoints used by the CLI:
 *   POST /v1/chat/completions   — OpenAI-compatible (streaming + non-streaming)
 *   POST /v1/anonymize          — { masked_text, mapping_id, count, ... }
 *   POST /v1/restore            — { restored_text }
 *
 * Design notes:
 *   - Uses Node 18+ global `fetch` and `AbortController` — no extra deps.
 *   - Retry: 3 attempts total, exponential backoff (200 / 400 / 800 ms),
 *     ONLY for network errors and 5xx. 4xx fails fast — retrying 401 / 402
 *     / 429-without-Retry-After spams the gateway and hides real problems.
 *   - Streaming: a tiny SSE parser (`for await` over the response body),
 *     yields the raw `data:` payloads so the caller can route OpenAI deltas.
 *   - Aborts: we accept an external AbortSignal (so Ctrl-C in `brikko chat`
 *     cancels the in-flight request).
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_ATTEMPTS = 3;

/* ──────────────────────────────────────────────────────────────────────── */
/* Errors                                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

export class ApiError extends Error {
  override name = "ApiError" as const;
  status: number;
  body?: unknown;
  retryable: boolean;

  constructor(message: string, status: number, body?: unknown, retryable = false) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

export class NetworkError extends Error {
  override name = "NetworkError" as const;
  override cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    if (cause) this.cause = cause;
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Public API types                                                         */
/* ──────────────────────────────────────────────────────────────────────── */

export interface ApiClientOptions {
  apiKey: string;
  apiBase: string;
  /** Override fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override sleep for tests (so we don't actually wait between retries). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices: Array<{
    index?: number;
    message: ChatMessage;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface AnonymizeResponse {
  masked_text: string;
  mapping_id: string;
  count: number;
  audit?: unknown;
  expires_at_unix?: number;
}

export interface RestoreResponse {
  restored_text: string;
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Client                                                                   */
/* ──────────────────────────────────────────────────────────────────────── */

export class BrikkoApiClient {
  private apiKey: string;
  private apiBase: string;
  private fetchImpl: typeof fetch;
  private sleepImpl: (ms: number) => Promise<void>;
  private timeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.apiKey = opts.apiKey;
    // Strip trailing slash so we can join with `/v1/...` cleanly.
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = opts.sleepImpl ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Non-streaming chat completion. Returns the parsed JSON response. */
  async chatCompletion(
    body: ChatCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const res = await this.requestWithRetry(
      "/v1/chat/completions",
      { ...body, stream: false },
      signal,
    );
    return (await res.json()) as ChatCompletionResponse;
  }

  /**
   * Streaming chat completion. Yields parsed SSE `data:` payloads
   * (each one is the JSON-decoded delta object from OpenAI's format).
   * Stops on `[DONE]`. Errors propagate as ApiError / NetworkError.
   */
  async *chatCompletionStream(
    body: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown, void, void> {
    const res = await this.requestWithRetry(
      "/v1/chat/completions",
      { ...body, stream: true },
      signal,
    );
    if (!res.body) {
      throw new NetworkError("Streaming response had no body");
    }
    yield* parseSse(res.body);
  }

  async anonymize(text: string, signal?: AbortSignal): Promise<AnonymizeResponse> {
    const res = await this.requestWithRetry("/v1/anonymize", { text }, signal);
    return (await res.json()) as AnonymizeResponse;
  }

  async restore(
    text: string,
    mappingId: string,
    signal?: AbortSignal,
  ): Promise<RestoreResponse> {
    const res = await this.requestWithRetry(
      "/v1/restore",
      { text, mapping_id: mappingId },
      signal,
    );
    return (await res.json()) as RestoreResponse;
  }

  /* ─── internals ─── */

  private async requestWithRetry(
    path: string,
    body: unknown,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.requestOnce(path, body, externalSignal);
      } catch (err) {
        lastErr = err as Error;
        // Never retry user-cancelled requests.
        if (externalSignal?.aborted) throw err;
        const retryable =
          err instanceof NetworkError ||
          (err instanceof ApiError && err.retryable);
        if (!retryable || attempt === RETRY_MAX_ATTEMPTS) throw err;
        // 200 → 400 → 800 ms
        await this.sleepImpl(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
    // Unreachable (loop returns or throws), but TS likes a guarantee.
    throw lastErr ?? new NetworkError("Unknown error");
  }

  private async requestOnce(
    path: string,
    body: unknown,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.apiBase}${path}`;
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort(externalSignal.reason);
      else externalSignal.addEventListener("abort", onAbort, { once: true });
    }
    const timeout = setTimeout(() => ctrl.abort(new Error("Timeout")), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": userAgent(),
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      // fetch only throws on network failure / abort; treat both, but only
      // network failures should be retried.
      if (externalSignal?.aborted) throw err;
      throw new NetworkError(
        `Network error talking to ${url}: ${(err as Error).message}`,
        err as Error,
      );
    } finally {
      clearTimeout(timeout);
      if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
    }

    if (res.ok) return res;

    // Non-2xx — drain body for diagnostics, then throw.
    const text = await res.text().catch(() => "");
    let parsed: unknown = text;
    if (text && text.startsWith("{")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep as text */
      }
    }
    const retryable = res.status >= 500 && res.status <= 599;
    throw new ApiError(
      humanErrorMessage(res.status, parsed),
      res.status,
      parsed,
      retryable,
    );
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function userAgent(): string {
  // We can't import package.json at runtime here without a build-time step;
  // a static identifier is fine — it's purely informational on the server.
  return "brikko-cli/0.2.0 (+https://github.com/brikkoAI/brikko-cli)";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanErrorMessage(status: number, body: unknown): string {
  // Try to extract { error: { message } } shape (OpenAI / Brikko style).
  let detail = "";
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const errObj = obj["error"];
    if (errObj && typeof errObj === "object") {
      const msg = (errObj as Record<string, unknown>)["message"];
      if (typeof msg === "string") detail = msg;
    } else if (typeof obj["message"] === "string") {
      detail = obj["message"] as string;
    }
  } else if (typeof body === "string" && body.trim()) {
    detail = body.slice(0, 200);
  }
  if (status === 401) {
    return `401 Unauthorized — проверь API ключ (https://brikko.ru/app/keys).${detail ? " " + detail : ""}`;
  }
  if (status === 402) {
    return `402 Insufficient balance — пополни счёт на https://brikko.ru/app/billing.${detail ? " " + detail : ""}`;
  }
  if (status === 429) {
    return `429 Too Many Requests — притормози или подожди.${detail ? " " + detail : ""}`;
  }
  return `HTTP ${status}${detail ? ": " + detail : ""}`;
}

/**
 * Parse an SSE byte stream and yield the JSON-decoded `data:` payloads.
 * Ignores `[DONE]` sentinel and non-data fields. Tolerates partial frames
 * across chunk boundaries.
 */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line (\n\n or \r\n\r\n).
      let sepIdx: number;
      while ((sepIdx = findEventBoundary(buf)) !== -1) {
        const event = buf.slice(0, sepIdx);
        // skip the blank-line terminator (1 or 2 chars depending on \r\n)
        buf = buf.slice(sepIdx).replace(/^(\r?\n){2}/, "");
        const data = collectData(event);
        if (data === null) continue;
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          // Skip malformed frames rather than crashing the whole stream.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findEventBoundary(s: string): number {
  // Returns index of the first \n\n / \r\n\r\n in `s`, or -1 if none.
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function collectData(event: string): string | null {
  // SSE event may have multiple `data:` lines — concatenated with \n.
  const lines = event.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length === 0 ? null : dataLines.join("\n");
}

/**
 * Pull the user-visible delta text from one OpenAI streaming chunk.
 * Returns "" if this chunk has no text (e.g. role-only opener).
 */
export function extractStreamDelta(chunk: unknown): string {
  if (!chunk || typeof chunk !== "object") return "";
  const choices = (chunk as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const delta = (first as Record<string, unknown>)["delta"];
  if (!delta || typeof delta !== "object") return "";
  const content = (delta as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : "";
}

/**
 * Pull the full assistant text from a non-streaming chat response.
 */
export function extractCompletionText(res: ChatCompletionResponse): string {
  const choice = res.choices?.[0];
  if (!choice) return "";
  return choice.message?.content ?? "";
}
