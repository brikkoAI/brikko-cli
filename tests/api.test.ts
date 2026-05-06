/**
 * tests/api.test.ts — exercises BrikkoApiClient with a stubbed `fetch`.
 * No network is hit. Covers:
 *   - Authorization header
 *   - JSON body shape for chat / anonymize / restore
 *   - 4xx → ApiError fail-fast (no retry)
 *   - 5xx → retry up to 3 attempts
 *   - Network failure → retry, then NetworkError
 *   - SSE streaming parser yields the right deltas + stops at [DONE]
 *   - extractStreamDelta / extractCompletionText helpers
 */

import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  BrikkoApiClient,
  NetworkError,
  extractCompletionText,
  extractStreamDelta,
} from "../src/lib/api.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function errorResponse(status: number, body: unknown = { error: { message: "boom" } }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch): BrikkoApiClient {
  return new BrikkoApiClient({
    apiKey: "sk-brk-test",
    apiBase: "https://api.brikko.test",
    fetchImpl,
    sleepImpl: () => Promise.resolve(),
  });
}

describe("BrikkoApiClient.chatCompletion", () => {
  it("sends Authorization header and JSON body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer sk-brk-test");
      expect(headers.get("Content-Type")).toBe("application/json");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body["model"]).toBe("auto:cheap");
      expect(body["stream"]).toBe(false);
      expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "hello" } }] });
    });
    const c = client(fetchMock as unknown as typeof fetch);
    const res = await c.chatCompletion({
      model: "auto:cheap",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(extractCompletionText(res)).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 401", async () => {
    const fetchMock = vi.fn(async () => errorResponse(401));
    const c = client(fetchMock as unknown as typeof fetch);
    await expect(
      c.chatCompletion({ model: "x", messages: [{ role: "user", content: "" }] }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 402", async () => {
    const fetchMock = vi.fn(async () => errorResponse(402));
    const c = client(fetchMock as unknown as typeof fetch);
    await expect(
      c.chatCompletion({ model: "x", messages: [{ role: "user", content: "" }] }),
    ).rejects.toMatchObject({ status: 402 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 3x on 503 then surfaces ApiError", async () => {
    const fetchMock = vi.fn(async () => errorResponse(503));
    const c = client(fetchMock as unknown as typeof fetch);
    await expect(
      c.chatCompletion({ model: "x", messages: [{ role: "user", content: "" }] }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on network failure then surfaces NetworkError", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const c = client(fetchMock as unknown as typeof fetch);
    await expect(
      c.chatCompletion({ model: "x", messages: [{ role: "user", content: "" }] }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("succeeds on retry after a 503", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return errorResponse(503);
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    });
    const c = client(fetchMock as unknown as typeof fetch);
    const res = await c.chatCompletion({
      model: "x",
      messages: [{ role: "user", content: "" }],
    });
    expect(extractCompletionText(res)).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("strips trailing slashes from apiBase", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.brikko.test/v1/chat/completions");
      return jsonResponse({ choices: [{ message: { role: "assistant", content: "" } }] });
    });
    const c = new BrikkoApiClient({
      apiKey: "sk-brk-test",
      apiBase: "https://api.brikko.test///",
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleepImpl: () => Promise.resolve(),
    });
    await c.chatCompletion({ model: "x", messages: [{ role: "user", content: "" }] });
  });
});

describe("BrikkoApiClient.anonymize / restore", () => {
  it("anonymize POSTs to /v1/anonymize with { text }", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.brikko.test/v1/anonymize");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).toEqual({ text: "ИНН 7707083893" });
      return jsonResponse({
        masked_text: "ИНН <INN_1>",
        mapping_id: "abc123",
        count: 1,
        expires_at_unix: 1_800_000_000,
      });
    });
    const c = client(fetchMock as unknown as typeof fetch);
    const res = await c.anonymize("ИНН 7707083893");
    expect(res.mapping_id).toBe("abc123");
    expect(res.count).toBe(1);
  });

  it("restore POSTs { text, mapping_id }", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.brikko.test/v1/restore");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).toEqual({ text: "<NAME_1> подписал", mapping_id: "abc123" });
      return jsonResponse({ restored_text: "Иванов подписал" });
    });
    const c = client(fetchMock as unknown as typeof fetch);
    const res = await c.restore("<NAME_1> подписал", "abc123");
    expect(res.restored_text).toBe("Иванов подписал");
  });
});

describe("SSE streaming parser", () => {
  it("yields decoded chunks and stops at [DONE]", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":", world"}}]}',
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n");

    const fetchMock = vi.fn(async () => {
      return new Response(sseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const c = client(fetchMock as unknown as typeof fetch);
    const collected: string[] = [];
    for await (const chunk of c.chatCompletionStream({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
    })) {
      const delta = extractStreamDelta(chunk);
      if (delta) collected.push(delta);
    }
    expect(collected.join("")).toBe("Hello, world");
  });

  it("tolerates partial frames split across chunks", async () => {
    // Build a stream where a single SSE event is split across two reads.
    const part1 = 'data: {"choices":[{"delta":{"content":"par';
    const part2 = 'tial"}}]}\n\ndata: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(part1));
        controller.enqueue(enc.encode(part2));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(stream, { status: 200 }));
    const c = client(fetchMock as unknown as typeof fetch);
    const collected: string[] = [];
    for await (const chunk of c.chatCompletionStream({
      model: "x",
      messages: [{ role: "user", content: "" }],
    })) {
      const delta = extractStreamDelta(chunk);
      if (delta) collected.push(delta);
    }
    expect(collected.join("")).toBe("partial");
  });
});

describe("extractStreamDelta / extractCompletionText", () => {
  it("returns empty string for malformed input", () => {
    expect(extractStreamDelta(null)).toBe("");
    expect(extractStreamDelta({})).toBe("");
    expect(extractStreamDelta({ choices: [] })).toBe("");
    expect(extractStreamDelta({ choices: [{}] })).toBe("");
  });
  it("returns content from choices[0].delta.content", () => {
    expect(extractStreamDelta({ choices: [{ delta: { content: "x" } }] })).toBe("x");
  });
  it("extractCompletionText is robust to missing choices", () => {
    expect(
      extractCompletionText({ choices: [] }),
    ).toBe("");
    expect(
      extractCompletionText({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
    ).toBe("ok");
  });
});
