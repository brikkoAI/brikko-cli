/**
 * tests/proxy.server.test.ts — black-box tests for the proxy HTTP server.
 *
 * We bring up a real `http.Server` on a random port and hit it with `fetch`,
 * mocking the upstream via the injectable `fetchImpl`. This is the most
 * realistic test possible without a network round-trip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../src/lib/proxy/server.js";
import { nullLogger } from "../src/lib/proxy/logger.js";

let handle: Awaited<ReturnType<typeof startServer>> | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  vi.restoreAllMocks();
});

async function pickPort(): Promise<number> {
  // Use 0 to let the OS pick — but our server hardcodes 127.0.0.1:port
  // and we want a fresh port for each test. Take a random high port and
  // hope for no collision (CI matrix is fine: tests in serial within a job).
  const { createServer } = await import("node:net");
  return new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

describe("proxy server: /healthz", () => {
  it("returns ok:true even when upstream is down", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("upstream unreachable");
    });
    const port = await pickPort();
    handle = await startServer({
      port,
      apiBase: "https://api.brikko.test",
      apiKey: "sk-brk-test",
      piiProtect: false,
      logger: nullLogger(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      cliVersion: "0.3.0",
    });
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["upstream_ok"]).toBe(false);
    expect(body["port"]).toBe(port);
    expect(body["pii_protect"]).toBe(false);
  });

  it("reports upstream_ok:true when upstream /healthz returns 200", async () => {
    const fetchMock = vi.fn(async () => new Response("OK", { status: 200 }));
    const port = await pickPort();
    handle = await startServer({
      port,
      apiBase: "https://api.brikko.test",
      apiKey: "sk-brk-test",
      piiProtect: true,
      logger: nullLogger(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      cliVersion: "0.3.0",
    });
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["upstream_ok"]).toBe(true);
    expect(body["pii_protect"]).toBe(true);
  });
});

describe("proxy server: forwarding", () => {
  it("strips client Authorization and injects our API key", async () => {
    let observedAuth: string | null = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      observedAuth = headers.get("Authorization");
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const port = await pickPort();
    handle = await startServer({
      port,
      apiBase: "https://api.brikko.test",
      apiKey: "sk-brk-server-key",
      piiProtect: false, // simpler path for this assertion
      logger: nullLogger(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      cliVersion: "0.3.0",
    });
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-CLIENT-KEY", // should be stripped
      },
      body: JSON.stringify({ model: "auto:cheap", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    expect(observedAuth).toBe("Bearer sk-brk-server-key");
  });

  it("returns 502 when upstream throws (network error)", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      // /healthz succeeds (used internally), real endpoints fail.
      if (String(url).endsWith("/healthz")) {
        return new Response("OK", { status: 200 });
      }
      throw new TypeError("fetch failed");
    });
    const port = await pickPort();
    handle = await startServer({
      port,
      apiBase: "https://api.brikko.test",
      apiKey: "sk-brk-test",
      piiProtect: false,
      logger: nullLogger(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      cliVersion: "0.3.0",
    });
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(r.status).toBe(502);
    const body = (await r.json()) as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["type"]).toBe("upstream_error");
  });

  it("passes through status codes verbatim", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { message: "no balance" } }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    });
    const port = await pickPort();
    handle = await startServer({
      port,
      apiBase: "https://api.brikko.test",
      apiKey: "sk-brk-test",
      piiProtect: false,
      logger: nullLogger(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      cliVersion: "0.3.0",
    });
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(r.status).toBe(402);
  });
});

describe("proxy server: /__brikko/stats", () => {
  it("returns counter snapshot", async () => {
    const fetchMock = vi.fn(async () => new Response("OK", { status: 200 }));
    const port = await pickPort();
    handle = await startServer({
      port,
      apiBase: "https://api.brikko.test",
      apiKey: "sk-brk-test",
      piiProtect: false,
      logger: nullLogger(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      cliVersion: "0.3.0",
    });
    const r = await fetch(`http://127.0.0.1:${port}/__brikko/stats`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["requests"]).toBe(0);
    expect(body["startedAt"]).toBeGreaterThan(0);
  });

  it("404s on other /__brikko/* paths", async () => {
    const fetchMock = vi.fn(async () => new Response("OK", { status: 200 }));
    const port = await pickPort();
    handle = await startServer({
      port,
      apiBase: "https://api.brikko.test",
      apiKey: "sk-brk-test",
      piiProtect: false,
      logger: nullLogger(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      cliVersion: "0.3.0",
    });
    const r = await fetch(`http://127.0.0.1:${port}/__brikko/admin`);
    expect(r.status).toBe(404);
  });
});
