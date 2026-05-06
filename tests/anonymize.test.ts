/**
 * tests/anonymize.test.ts — `brikko anonymize` command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let stdoutBuf = "";
let stderrBuf = "";
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdoutBuf = "";
  stderrBuf = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array): boolean => {
    stdoutBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array): boolean => {
    stderrBuf += typeof s === "string" ? s : new TextDecoder().decode(s);
    return true;
  }) as typeof process.stderr.write);

  vi.doMock("../src/lib/auth.js", () => ({
    resolveAuth: vi.fn(async () => ({
      apiKey: "sk-brk-test",
      apiBase: "https://api.brikko.test",
      source: "env",
    })),
    AuthError: class AuthError extends Error {},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../src/lib/auth.js");
  vi.doUnmock("../src/lib/api.js");
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
});

function mockApi(anonymize: () => Promise<unknown>): void {
  vi.doMock("../src/lib/api.js", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
      "../src/lib/api.js",
    );
    return {
      ...actual,
      BrikkoApiClient: vi.fn().mockImplementation(() => ({ anonymize })),
    };
  });
}

describe("brikko anonymize", () => {
  it("emits compact JSON by default", async () => {
    mockApi(async () => ({
      masked_text: "ИНН <INN_1>",
      mapping_id: "abc",
      count: 1,
    }));
    const { anonymize } = await import("../src/commands/anonymize.js");
    const code = await anonymize({ text: "ИНН 7707083893" });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
    expect(parsed["masked_text"]).toBe("ИНН <INN_1>");
    expect(parsed["mapping_id"]).toBe("abc");
  });

  it("prints a human-readable block with --pretty", async () => {
    mockApi(async () => ({
      masked_text: "<NAME_1> here",
      mapping_id: "xyz",
      count: 1,
      expires_at_unix: 1_800_000_000,
    }));
    const { anonymize } = await import("../src/commands/anonymize.js");
    const code = await anonymize({ text: "Ivan here", pretty: true });
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/Masked/);
    expect(stdoutBuf).toMatch(/<NAME_1> here/);
    expect(stdoutBuf).toMatch(/xyz/);
  });

  it("returns 1 on empty input", async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const { anonymize } = await import("../src/commands/anonymize.js");
      const code = await anonymize({});
      expect(code).toBe(1);
      expect(stderrBuf).toMatch(/Пустой текст/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });

  it("propagates ApiError to exit 1", async () => {
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({
          anonymize: vi.fn(async () => {
            throw new actual.ApiError("402 Insufficient balance", 402);
          }),
        })),
      };
    });
    const { anonymize } = await import("../src/commands/anonymize.js");
    const code = await anonymize({ text: "Иван Иванов" });
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/402/);
  });
});
