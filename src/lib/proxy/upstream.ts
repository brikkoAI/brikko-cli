/**
 * Upstream proxying to api.brikko.ru — the core HTTP forwarder used by the
 * local proxy daemon.
 *
 * Responsibilities:
 *   - Build the upstream URL (apiBase + req.url).
 *   - Filter request headers (drop hop-by-hop, drop client's incoming Auth,
 *     inject our own `Authorization: Bearer <key>`, set User-Agent).
 *   - Stream the request body upstream (uses Node 18+ ReadableStream → fetch).
 *   - Stream the upstream response body back to the client (works for
 *     JSON, NDJSON, multipart, and SSE — fetch's body is a ReadableStream).
 *   - Surface upstream errors as 502 Bad Gateway (network) or pass-through
 *     (any HTTP status from upstream — we are a transparent proxy).
 *
 * Streaming SSE: when the upstream returns `text/event-stream`, we keep the
 * connection open and pump bytes; the caller (server.ts) is responsible for
 * setting the right response headers (Cache-Control: no-cache, etc).
 *
 * Hop-by-hop headers per RFC 7230 §6.1 — these MUST NOT be forwarded.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** Headers that must not be forwarded between client ↔ upstream. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // Host is per-connection; fetch will set a fresh one for the upstream.
  "host",
  // Don't leak the client's Authorization upstream — we replace it with
  // OUR API key so the user-agent doesn't have to.
  "authorization",
  // Content-Length will be re-derived by fetch when we re-stream.
  "content-length",
]);

export interface ForwardOptions {
  apiBase: string;
  apiKey: string;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override User-Agent. */
  userAgent?: string;
  /** Per-request timeout in ms. Default 600s (long enough for big streams). */
  timeoutMs?: number;
}

export interface ForwardResult {
  status: number;
  /** Number of body bytes streamed back to the client (for logging). */
  bytesOut: number;
  /** True if the upstream response was SSE. */
  streamed: boolean;
}

/**
 * Forward an incoming HTTP request to the Brikko gateway and pipe the
 * response back to the client. Returns when the response is fully sent.
 *
 * Errors:
 *   - Upstream network failure → writes 502 + JSON body, returns status 502.
 *   - Upstream HTTP error (4xx/5xx) → passes through verbatim, returns status.
 *   - Client aborts mid-flight → propagates abort to upstream, throws AbortError.
 */
export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ForwardOptions,
): Promise<ForwardResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const apiBase = opts.apiBase.replace(/\/+$/, "");
  const url = `${apiBase}${req.url ?? "/"}`;

  // Build outgoing headers — strip hop-by-hop, inject our auth.
  const outHeaders: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    "User-Agent": opts.userAgent ?? "brikko-cli-proxy",
  };
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (value === undefined) continue;
    outHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  // Body: GET/HEAD have no body; everything else is streamed.
  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  // Wire up client-disconnect → upstream-abort.
  const ctrl = new AbortController();
  const onClientClose = (): void => ctrl.abort(new Error("client disconnected"));
  req.on("close", onClientClose);

  // Per-request timeout (defensive — keeps a stuck upstream from hanging
  // the daemon forever).
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const timeout = setTimeout(() => ctrl.abort(new Error("upstream timeout")), timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method,
      headers: outHeaders,
      // Node fetch accepts a Node Readable as a body (undici under the hood);
      // duplex:'half' is required when streaming a request body.
      ...(hasBody
        ? {
            body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
            duplex: "half",
          }
        : {}),
      signal: ctrl.signal,
    } as RequestInit & { duplex?: "half" });
  } catch (err) {
    clearTimeout(timeout);
    req.off("close", onClientClose);
    if (ctrl.signal.aborted && req.destroyed) {
      // Client gave up — nothing to write back.
      throw err;
    }
    // Network error talking upstream → 502.
    if (!res.headersSent) {
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
    throw err;
  }

  // Mirror upstream status + headers, minus hop-by-hop.
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (HOP_BY_HOP.has(name.toLowerCase())) return;
    // node:http auto-sets transfer-encoding/content-length when we use res.write.
    if (name.toLowerCase() === "content-encoding") {
      // fetch already decoded gzip/br for us; passing the original encoding
      // header would lie to the client.
      return;
    }
    res.setHeader(name, value);
  });

  const ctype = upstream.headers.get("content-type") ?? "";
  const streamed = ctype.startsWith("text/event-stream");
  if (streamed) {
    // Belt-and-suspenders for SSE — these should already be set by upstream
    // but some clients are picky.
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
  }

  // Pipe upstream body → client. Empty body (e.g. 204) is fine.
  let bytesOut = 0;
  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytesOut += value.byteLength;
        // res.write returns false if the kernel buffer is full — await drain
        // so we don't OOM on a slow client.
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      }
    } catch (err) {
      // Reader failed mid-stream (network blip, client gone).
      if (!res.writableEnded) res.end();
      clearTimeout(timeout);
      req.off("close", onClientClose);
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* lock already released */
      }
    }
  }

  clearTimeout(timeout);
  req.off("close", onClientClose);
  if (!res.writableEnded) res.end();
  return { status: upstream.status, bytesOut, streamed };
}
