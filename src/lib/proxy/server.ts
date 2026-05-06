/**
 * Local HTTP proxy server — the heart of `brikko proxy start`.
 *
 * Endpoints (matched in order):
 *
 *   GET  /healthz                      → { ok, upstream_ok, uptime_s, ... }
 *                                         Always responds 200 even when
 *                                         api.brikko.ru is down — this is
 *                                         a "is the daemon alive?" probe.
 *
 *   GET  /__brikko/stats               → counters snapshot (loopback-only)
 *
 *   POST /v1/chat/completions          → forward (with PII pipeline by default)
 *   POST /v1/embeddings                → forward (with PII pipeline by default)
 *   POST /v1/audio/transcriptions      → forward (NO PII pipeline, V0.3)
 *   GET  /v1/models                    → forward
 *   POST /v1/anonymize                 → forward
 *   POST /v1/restore                   → forward
 *   ANY  /*                            → forward (transparent pass-through)
 *
 * Configuration is decided once at start time (server config object) — no
 * per-request reconfiguration. The PII pipeline can be globally disabled
 * via `--no-pii-protect` to ship traffic raw to api.brikko.ru.
 *
 * Bind address: 127.0.0.1 only. Exposing the daemon on 0.0.0.0 would mean
 * anyone on the LAN can hit it with the user's API key — that's a
 * footgun we refuse to ship in V0.3.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { forward } from "./upstream.js";
import { forwardWithPii } from "./piiPipeline.js";
import type { ProxyLogger } from "./logger.js";
import { createCounters, type CountersHandle } from "./counters.js";

export interface ProxyServerConfig {
  port: number;
  apiBase: string;
  apiKey: string;
  /** When true, anonymize → forward → restore for chat/embeddings. */
  piiProtect: boolean;
  logger: ProxyLogger;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Reported in /healthz. */
  cliVersion: string;
}

export interface ProxyServerHandle {
  server: Server;
  counters: CountersHandle;
  /** Resolves when the underlying socket is closed. */
  close(): Promise<void>;
}

export function startServer(cfg: ProxyServerConfig): Promise<ProxyServerHandle> {
  const counters = createCounters();
  const log = cfg.logger;

  const server = createServer((req, res) => {
    void handle(req, res, cfg, counters, log).catch((err) => {
      // Last-ditch error handler — don't crash the daemon.
      log.error("handler.crash", { error: (err as Error).message, url: req.url });
      if (!res.writableEnded) {
        try {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              error: { message: "Internal proxy error", type: "proxy_internal" },
            }),
          );
        } catch {
          /* socket likely already destroyed */
        }
      }
    });
  });

  // Reject Connection: Upgrade — we don't proxy WebSockets in V0.3.
  server.on("upgrade", (_req, socket) => {
    try {
      socket.write(
        "HTTP/1.1 501 Not Implemented\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    } finally {
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", () => {
      server.off("error", reject);
      log.info("server.listen", { port: cfg.port, pii_protect: cfg.piiProtect });
      resolve({
        server,
        counters,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/* ------------------------------------------------------------------------- */
/* Request handler                                                            */
/* ------------------------------------------------------------------------- */

const PII_ENABLED_ENDPOINTS: Record<string, "chat" | "embeddings"> = {
  "/v1/chat/completions": "chat",
  "/v1/embeddings": "embeddings",
};

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ProxyServerConfig,
  counters: CountersHandle,
  log: ProxyLogger,
): Promise<void> {
  const start = Date.now();
  const path = stripQuery(req.url ?? "/");
  const method = (req.method ?? "GET").toUpperCase();

  // /healthz — local liveness probe. Doesn't consume the user's API quota.
  if (method === "GET" && path === "/healthz") {
    return await healthz(req, res, cfg, counters);
  }

  // /__brikko/stats — admin/diagnostics endpoint.
  if (method === "GET" && path === "/__brikko/stats") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(counters.snapshot(), null, 2));
    return;
  }

  // Block /__brikko/* writes — only stats is read-only.
  if (path.startsWith("/__brikko/")) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { message: "Not found", type: "not_found" } }));
    return;
  }

  // Decide whether this endpoint goes through the PII pipeline.
  const piiEndpoint = cfg.piiProtect && method === "POST" ? PII_ENABLED_ENDPOINTS[path] : undefined;

  let result: { status: number; bytesOut: number; streamed: boolean };
  try {
    if (piiEndpoint) {
      result = await forwardWithPii(req, res, {
        apiBase: cfg.apiBase,
        apiKey: cfg.apiKey,
        ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
        userAgent: `brikko-cli-proxy/${cfg.cliVersion}`,
        endpoint: piiEndpoint,
        logger: log,
      });
      counters.recordMask();
    } else {
      result = await forward(req, res, {
        apiBase: cfg.apiBase,
        apiKey: cfg.apiKey,
        ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
        userAgent: `brikko-cli-proxy/${cfg.cliVersion}`,
      });
    }
  } catch (err) {
    // Client disconnect or a thrown error in upstream forwarding.
    log.warn("forward.err", {
      method,
      path,
      error: (err as Error).message,
    });
    counters.recordError();
    return;
  }

  const dur = Date.now() - start;
  counters.recordRequest(result.status, 0, result.bytesOut, dur);
  if (result.status >= 500) counters.recordError();

  log.info("req", {
    method,
    path,
    status: result.status,
    bytes_out: result.bytesOut,
    streamed: result.streamed,
    duration_ms: dur,
    pii: piiEndpoint ?? null,
  });
}

/* ------------------------------------------------------------------------- */
/* /healthz                                                                  */
/* ------------------------------------------------------------------------- */

async function healthz(
  _req: IncomingMessage,
  res: ServerResponse,
  cfg: ProxyServerConfig,
  counters: CountersHandle,
): Promise<void> {
  // Best-effort upstream probe. 2-second timeout — we never want /healthz
  // to take more than ~2s.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  let upstreamOk = false;
  try {
    const r = await (cfg.fetchImpl ?? globalThis.fetch.bind(globalThis))(
      `${cfg.apiBase.replace(/\/+$/, "")}/healthz`,
      { signal: ctrl.signal },
    );
    upstreamOk = r.ok;
  } catch {
    upstreamOk = false;
  } finally {
    clearTimeout(t);
  }

  const snap = counters.snapshot();
  const body = {
    ok: true,
    upstream_ok: upstreamOk,
    uptime_s: Math.round((Date.now() - snap.startedAt) / 1000),
    cli_version: cfg.cliVersion,
    port: cfg.port,
    pii_protect: cfg.piiProtect,
    counters: {
      requests: snap.requests,
      requests_by_status: snap.requestsByStatus,
      errors: snap.errors,
      masks: snap.masks,
    },
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}
