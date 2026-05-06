/**
 * tests/safeChat.test.ts — the killer compliance command.
 *
 * Verifies the orchestration: anonymize → chat → restore, with the same
 * mapping_id passed through, and both order + idempotence around count=0.
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

describe("brikko safe-chat", () => {
  it("runs anonymize → chat → restore and prints the restored answer", async () => {
    const calls: string[] = [];
    const anonymize = vi.fn(async (text: string) => {
      calls.push(`anonymize:${text}`);
      return {
        masked_text: "Письмо клиенту <NAME_1> с ИНН <INN_1>",
        mapping_id: "map-1",
        count: 2,
      };
    });
    const chatCompletion = vi.fn(async (req: { messages: Array<{ content: string }> }) => {
      calls.push(`chat:${req.messages[0]?.content}`);
      return {
        choices: [
          {
            message: {
              role: "assistant" as const,
              content: "Здравствуйте, <NAME_1>! По вашему ИНН <INN_1> всё ок.",
            },
          },
        ],
      };
    });
    const restore = vi.fn(async (text: string, mappingId: string) => {
      calls.push(`restore:${mappingId}:${text}`);
      return { restored_text: "Здравствуйте, Иванов! По вашему ИНН 7707083893 всё ок." };
    });
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({
          anonymize,
          chatCompletion,
          restore,
        })),
      };
    });

    const { safeChat } = await import("../src/commands/safeChat.js");
    const code = await safeChat({ prompt: "Письмо клиенту Иванову с ИНН 7707083893" });
    expect(code).toBe(0);
    // Order check
    expect(calls).toEqual([
      "anonymize:Письмо клиенту Иванову с ИНН 7707083893",
      "chat:Письмо клиенту <NAME_1> с ИНН <INN_1>",
      "restore:map-1:Здравствуйте, <NAME_1>! По вашему ИНН <INN_1> всё ок.",
    ]);
    expect(stdoutBuf).toBe("Здравствуйте, Иванов! По вашему ИНН 7707083893 всё ок.\n");
  });

  it("skips restore when anonymize.count === 0 (idempotence safeguard)", async () => {
    const restore = vi.fn();
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({
          anonymize: vi.fn(async () => ({
            masked_text: "no PII here",
            mapping_id: "m",
            count: 0,
          })),
          chatCompletion: vi.fn(async () => ({
            choices: [
              { message: { role: "assistant" as const, content: "still no PII here" } },
            ],
          })),
          restore,
        })),
      };
    });
    const { safeChat } = await import("../src/commands/safeChat.js");
    const code = await safeChat({ prompt: "no PII here" });
    expect(code).toBe(0);
    expect(restore).not.toHaveBeenCalled();
    expect(stdoutBuf).toBe("still no PII here\n");
  });

  it("emits the full pipeline trace on --json", async () => {
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({
          anonymize: vi.fn(async () => ({
            masked_text: "<NAME_1>",
            mapping_id: "m1",
            count: 1,
          })),
          chatCompletion: vi.fn(async () => ({
            model: "auto:cheap",
            choices: [{ message: { role: "assistant" as const, content: "hi <NAME_1>" } }],
            usage: { total_tokens: 10 },
          })),
          restore: vi.fn(async () => ({ restored_text: "hi Ivan" })),
        })),
      };
    });
    const { safeChat } = await import("../src/commands/safeChat.js");
    const code = await safeChat({ prompt: "Ivan", json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    expect(parsed["mapping_id"]).toBe("m1");
    expect(parsed["pii_count"]).toBe(1);
    expect(parsed["assistant_final"]).toBe("hi Ivan");
    expect(parsed["assistant_masked"]).toBe("hi <NAME_1>");
  });

  it("returns 1 on empty prompt", async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const { safeChat } = await import("../src/commands/safeChat.js");
      const code = await safeChat({ prompt: "" });
      expect(code).toBe(1);
      expect(stderrBuf).toMatch(/Пустой prompt/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });
});
