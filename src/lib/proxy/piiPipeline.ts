/**
 * PII protection pipeline for the local proxy.
 *
 * What this does:
 *   When `pii_protect` is enabled (default for /v1/chat/completions and
 *   /v1/embeddings), we transparently anonymize the request body before
 *   forwarding it upstream, and restore PII placeholders in the response.
 *
 *   Non-streaming flow:
 *     1. Read full request body.
 *     2. Extract user-visible text (messages[].content for chat,
 *        input/string for embeddings).
 *     3. POST to /v1/anonymize → masked text + mapping_id.
 *     4. Replace originals in the request body with masked versions.
 *     5. Forward the masked body upstream → get full JSON response.
 *     6. Walk the response, POST any assistant text to /v1/restore with
 *        the same mapping_id.
 *     7. Send the restored response to the client.
 *
 *   Streaming (SSE) flow:
 *     1-4 as above.
 *     5. Forward request, pipe SSE chunks to client AS-IS (placeholders
 *        visible — that's the trade-off for low TTFT).
 *     6. Concurrently buffer the full streamed text.
 *     7. After [DONE], call /v1/restore on the full text and emit ONE
 *        custom event `event: brikko.restored\ndata: {...}\n\n` so a
 *        Brikko-aware client can swap placeholders for real values.
 *
 *   Endpoints we don't touch (V0.3):
 *     - /v1/audio/transcriptions — multipart/binary, no uplink masking;
 *       the transcript text isn't post-processed either (known limitation,
 *       documented in README; user can call /v1/anonymize manually).
 *     - Anything else not matching the chat/embeddings shape — pass-through.
 *
 * Implementation notes:
 *   - We use BrikkoApiClient (lib/api.ts) for /v1/anonymize and /v1/restore
 *     because it already has the right retry/error handling.
 *   - We tolerate any anonymize/restore failure gracefully: if the call
 *     fails, we log a warning and forward the ORIGINAL request — never
 *     drop the user's request because of a PII service blip.
 *   - Restoring at the response side is best-effort. If /v1/restore is
 *     down, the client gets placeholders, not an error.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { BrikkoApiClient } from "../api.js";
import { forward, type ForwardOptions, type ForwardResult } from "./upstream.js";
import type { ProxyLogger } from "./logger.js";

export interface PiiPipelineOptions extends ForwardOptions {
  logger: ProxyLogger;
  /** Path of the matched endpoint, e.g. "/v1/chat/completions". */
  endpoint: "chat" | "embeddings";
}

/**
 * Run the PII-protected proxy flow. Returns the same shape as `forward()`
 * so the caller can log identically.
 *
 * If anonymization fails we fall back to a plain forward — never block
 * the user request on a PII-side problem.
 */
export async function forwardWithPii(
  req: IncomingMessage,
  res: ServerResponse,
  opts: PiiPipelineOptions,
): Promise<ForwardResult> {
  const log = opts.logger;

  // 1. Buffer the request body (chat/embeddings bodies are bounded — ~MB
  // worst case for long conversations; embeddings batches even smaller).
  let raw: Buffer;
  try {
    raw = await readBody(req, 10 * 1024 * 1024); // 10 MB hard cap
  } catch (err) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const body = JSON.stringify({
      error: { message: (err as Error).message, type: "request_too_large" },
    });
    res.end(body);
    return { status: 413, bytesOut: Buffer.byteLength(body), streamed: false };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    // Not JSON — fall back to plain forward (we don't speak this dialect).
    log.warn("pii.skip.non-json", { endpoint: opts.endpoint });
    return forwardBuffered(req, res, raw, opts);
  }

  // 2. Extract the spans of user text we want to mask.
  const spans = extractSpans(parsed, opts.endpoint);
  if (spans.length === 0) {
    log.warn("pii.skip.no-text", { endpoint: opts.endpoint });
    return forwardBuffered(req, res, raw, opts);
  }

  // 3. Anonymize. We concatenate spans with a unique separator so we get
  // ONE mapping_id for the whole request — restoring later is symmetric.
  const sep = "\n\n---PII-SEP---\n\n";
  const joined = spans.map((s) => s.value).join(sep);

  const apiClient = new BrikkoApiClient({
    apiKey: opts.apiKey,
    apiBase: opts.apiBase,
  });

  let mappingId: string | undefined;
  let maskedJoined: string | undefined;
  try {
    const anon = await apiClient.anonymize(joined);
    mappingId = anon.mapping_id;
    maskedJoined = anon.masked_text;
    log.info("pii.anonymize.ok", {
      endpoint: opts.endpoint,
      count: anon.count,
      mapping_id: anon.mapping_id,
    });
  } catch (err) {
    // Anonymize failed — forward the original request unmodified.
    log.warn("pii.anonymize.fail", {
      endpoint: opts.endpoint,
      error: (err as Error).message,
    });
    return forwardBuffered(req, res, raw, opts);
  }

  // 4. Splice masked text back into the body.
  const maskedSpans = maskedJoined.split(sep);
  if (maskedSpans.length !== spans.length) {
    // Anonymizer mangled our separator (very unlikely, but handle it) —
    // fall back to plain forward.
    log.warn("pii.anonymize.span-mismatch", {
      endpoint: opts.endpoint,
      expected: spans.length,
      got: maskedSpans.length,
    });
    return forwardBuffered(req, res, raw, opts);
  }
  for (let i = 0; i < spans.length; i++) {
    spans[i]!.set(maskedSpans[i]!);
  }
  const maskedBody = Buffer.from(JSON.stringify(parsed), "utf8");

  // 5. Detect streaming.
  const isStream = parsed["stream"] === true;

  if (isStream) {
    return forwardStreamWithRestore(req, res, maskedBody, mappingId!, apiClient, opts);
  }

  // 6. Non-streaming: forward, parse upstream response, restore in-place.
  return forwardJsonWithRestore(req, res, maskedBody, mappingId!, apiClient, opts);
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

interface Span {
  value: string;
  set(masked: string): void;
}

/**
 * Pull out the user-visible text spans we want to anonymize.
 *
 * Chat: every messages[].content (string only — content arrays for vision
 * are passed-through untouched in V0.3).
 * Embeddings: input (string) or input[] (array of strings).
 */
function extractSpans(
  body: Record<string, unknown>,
  endpoint: "chat" | "embeddings",
): Span[] {
  const spans: Span[] = [];
  if (endpoint === "chat") {
    const msgs = body["messages"];
    if (!Array.isArray(msgs)) return spans;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m || typeof m !== "object") continue;
      const obj = m as Record<string, unknown>;
      const content = obj["content"];
      if (typeof content !== "string" || !content.trim()) continue;
      spans.push({
        value: content,
        set: (masked) => {
          obj["content"] = masked;
        },
      });
    }
  } else {
    // embeddings
    const input = body["input"];
    if (typeof input === "string" && input.trim()) {
      spans.push({
        value: input,
        set: (masked) => {
          body["input"] = masked;
        },
      });
    } else if (Array.isArray(input)) {
      for (let i = 0; i < input.length; i++) {
        const item = input[i];
        if (typeof item !== "string" || !item.trim()) continue;
        spans.push({
          value: item,
          set: (masked) => {
            (input as unknown[])[i] = masked;
          },
        });
      }
    }
  }
  return spans;
}

/** Read all of `req` into a Buffer, rejecting if we exceed `maxBytes`. */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Forward a fully-buffered request body upstream by wrapping it in a
 * fake IncomingMessage-like object that exposes the headers + a
 * Readable. Saves us from rebuilding the headers list.
 */
async function forwardBuffered(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  opts: ForwardOptions,
): Promise<ForwardResult> {
  // Wrap the buffer in a Readable and present it as an IncomingMessage-shaped
  // object to forward(). We deep-copy headers and override content-length
  // so upstream sees the right size.
  const stream = Readable.from([body]);
  const headers: NodeJS.Dict<string | string[]> = { ...req.headers };
  // Drop content-length — upstream/forward layer will handle framing.
  delete headers["content-length"];
  const fake = stream as unknown as IncomingMessage;
  Object.defineProperty(fake, "method", { value: req.method, configurable: true });
  Object.defineProperty(fake, "url", { value: req.url, configurable: true });
  Object.defineProperty(fake, "headers", { value: headers, configurable: true });
  return forward(fake, res, opts);
}

/**
 * Non-streaming response: forward, capture upstream JSON, restore PII
 * in assistant text, send to client.
 */
async function forwardJsonWithRestore(
  req: IncomingMessage,
  res: ServerResponse,
  maskedBody: Buffer,
  mappingId: string,
  apiClient: BrikkoApiClient,
  opts: PiiPipelineOptions,
): Promise<ForwardResult> {
  // Forward to a "capturing" response sink so we can rewrite before
  // hitting the real `res`. We bypass forward()'s direct piping by doing
  // the fetch ourselves — this keeps the JSON path simple.
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const apiBase = opts.apiBase.replace(/\/+$/, "");
  const url = `${apiBase}${req.url ?? "/"}`;

  const outHeaders = filterHopByHop(req.headers, opts.apiKey, opts.userAgent);

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: req.method ?? "POST",
      headers: outHeaders,
      body: maskedBody,
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const body = JSON.stringify({
      error: {
        message: `Brikko proxy: upstream unavailable (${(err as Error).message})`,
        type: "upstream_error",
      },
    });
    res.end(body);
    return { status: 502, bytesOut: Buffer.byteLength(body), streamed: false };
  }

  // Mirror status + non-hop headers.
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_OUT.has(lower)) return;
    if (lower === "content-encoding") return;
    if (lower === "content-length") return; // we'll rewrite the body
    res.setHeader(name, value);
  });

  const upstreamText = await upstream.text();
  let outText = upstreamText;

  // Try to restore. On any failure, send the masked text as-is (graceful).
  if (upstream.ok) {
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(upstreamText);
      } catch {
        parsed = null;
      }
      const candidates = collectAssistantText(parsed);
      if (candidates.length > 0) {
        const sep = "\n\n---PII-SEP---\n\n";
        const joined = candidates.map((c) => c.value).join(sep);
        try {
          const restored = await apiClient.restore(joined, mappingId);
          const parts = restored.restored_text.split(sep);
          if (parts.length === candidates.length) {
            for (let i = 0; i < candidates.length; i++) {
              candidates[i]!.set(parts[i]!);
            }
            outText = JSON.stringify(parsed);
            opts.logger.info("pii.restore.ok", {
              endpoint: opts.endpoint,
              mapping_id: mappingId,
            });
          } else {
            opts.logger.warn("pii.restore.span-mismatch", {
              endpoint: opts.endpoint,
              mapping_id: mappingId,
            });
          }
        } catch (err) {
          opts.logger.warn("pii.restore.fail", {
            endpoint: opts.endpoint,
            mapping_id: mappingId,
            error: (err as Error).message,
          });
        }
      }
    } catch (err) {
      opts.logger.warn("pii.restore.unexpected", {
        endpoint: opts.endpoint,
        error: (err as Error).message,
      });
    }
  }

  const outBuf = Buffer.from(outText, "utf8");
  res.setHeader("Content-Length", outBuf.length);
  res.end(outBuf);
  return { status: upstream.status, bytesOut: outBuf.length, streamed: false };
}

/**
 * Streaming response: pump SSE chunks to client, accumulate full text,
 * emit `brikko.restored` event at the end.
 */
async function forwardStreamWithRestore(
  req: IncomingMessage,
  res: ServerResponse,
  maskedBody: Buffer,
  mappingId: string,
  apiClient: BrikkoApiClient,
  opts: PiiPipelineOptions,
): Promise<ForwardResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const apiBase = opts.apiBase.replace(/\/+$/, "");
  const url = `${apiBase}${req.url ?? "/"}`;
  const outHeaders = filterHopByHop(req.headers, opts.apiKey, opts.userAgent);

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: req.method ?? "POST",
      headers: outHeaders,
      body: maskedBody,
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const body = JSON.stringify({
      error: {
        message: `Brikko proxy: upstream unavailable (${(err as Error).message})`,
        type: "upstream_error",
      },
    });
    res.end(body);
    return { status: 502, bytesOut: Buffer.byteLength(body), streamed: false };
  }

  res.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_OUT.has(lower)) return;
    if (lower === "content-encoding") return;
    res.setHeader(name, value);
  });
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  let bytesOut = 0;
  let buffer = ""; // for partial SSE frames across reads
  let assembled = ""; // full assistant content (cumulative)

  if (!upstream.body) {
    res.end();
    return { status: upstream.status, bytesOut: 0, streamed: true };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesOut += value.byteLength;

      // Pump to client AS-IS (placeholders visible — UX-acceptable trade-off).
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }

      // Also accumulate for /v1/restore at the end.
      buffer += decoder.decode(value, { stream: true });
      let sepIdx: number;
      while ((sepIdx = findEventBoundary(buffer)) !== -1) {
        const event = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx).replace(/^(\r?\n){2}/, "");
        const data = collectSseData(event);
        if (data === null) continue;
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as Record<string, unknown>;
          const choices = json["choices"];
          if (!Array.isArray(choices) || choices.length === 0) continue;
          const first = choices[0] as Record<string, unknown> | undefined;
          if (!first) continue;
          const delta = first["delta"] as Record<string, unknown> | undefined;
          if (!delta) continue;
          const content = delta["content"];
          if (typeof content === "string") assembled += content;
        } catch {
          /* skip malformed frames */
        }
      }
    }
  } catch (err) {
    opts.logger.warn("pii.stream.read-fail", {
      endpoint: opts.endpoint,
      error: (err as Error).message,
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  // Try to restore the assembled text and emit one final SSE event.
  if (assembled.trim()) {
    try {
      const restored = await apiClient.restore(assembled, mappingId);
      const restoredEvent =
        `event: brikko.restored\n` +
        `data: ${JSON.stringify({ index: 0, content: restored.restored_text })}\n\n`;
      res.write(restoredEvent);
      bytesOut += Buffer.byteLength(restoredEvent);
      opts.logger.info("pii.stream.restore.ok", {
        endpoint: opts.endpoint,
        mapping_id: mappingId,
        chars: restored.restored_text.length,
      });
    } catch (err) {
      opts.logger.warn("pii.stream.restore.fail", {
        endpoint: opts.endpoint,
        mapping_id: mappingId,
        error: (err as Error).message,
      });
    }
  }

  if (!res.writableEnded) res.end();
  return { status: upstream.status, bytesOut, streamed: true };
}

/* ----- shared SSE helpers (mini parser, kept local to not leak into api.ts) */

function findEventBoundary(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function collectSseData(event: string): string | null {
  const lines = event.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return dataLines.length === 0 ? null : dataLines.join("\n");
}

/** Walk a parsed JSON response and return refs to every assistant text. */
interface TextRef {
  value: string;
  set(restored: string): void;
}

function collectAssistantText(body: unknown): TextRef[] {
  const out: TextRef[] = [];
  if (!body || typeof body !== "object") return out;
  const obj = body as Record<string, unknown>;
  // OpenAI chat shape: choices[].message.content
  const choices = obj["choices"];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      const c = choice as Record<string, unknown>;
      const message = c["message"] as Record<string, unknown> | undefined;
      if (message && typeof message["content"] === "string" && (message["content"] as string).trim()) {
        out.push({
          value: message["content"] as string,
          set: (restored) => {
            message["content"] = restored;
          },
        });
      }
    }
  }
  // Embeddings response has no human-readable text — return empty.
  return out;
}

const HOP_BY_HOP_OUT = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filterHopByHop(
  headers: NodeJS.Dict<string | string[]>,
  apiKey: string,
  userAgent?: string,
): Record<string, string> {
  const out: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": userAgent ?? "brikko-cli-proxy",
  };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_OUT.has(lower)) continue;
    if (lower === "host" || lower === "authorization" || lower === "content-length") continue;
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
