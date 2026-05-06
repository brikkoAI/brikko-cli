/**
 * tests/chat.test.ts — command-level tests for `brikko chat`.
 * Mocks lib/auth + lib/api so we never touch the network or the FS.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture stdout
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

describe("brikko chat", () => {
  it("prints assistant text to stdout (default mode)", async () => {
    const chatCompletion = vi.fn(async () => ({
      choices: [{ message: { role: "assistant" as const, content: "Привет!" } }],
    }));
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({
          chatCompletion,
        })),
      };
    });
    const { chat } = await import("../src/commands/chat.js");
    const code = await chat({ prompt: "Hi" });
    expect(code).toBe(0);
    expect(stdoutBuf).toBe("Привет!\n");
    expect(chatCompletion).toHaveBeenCalledOnce();
    const callArgs = chatCompletion.mock.calls[0]?.[0] as { messages: unknown };
    expect(callArgs.messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("emits raw JSON when --json", async () => {
    const fakeRes = {
      id: "x",
      model: "auto:cheap",
      choices: [{ message: { role: "assistant" as const, content: "ok" } }],
    };
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({
          chatCompletion: vi.fn(async () => fakeRes),
        })),
      };
    });
    const { chat } = await import("../src/commands/chat.js");
    const code = await chat({ prompt: "x", json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    expect(parsed["model"]).toBe("auto:cheap");
  });

  it("includes system message when --system passed", async () => {
    const chatCompletion = vi.fn(async () => ({
      choices: [{ message: { role: "assistant" as const, content: "" } }],
    }));
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({ chatCompletion })),
      };
    });
    const { chat } = await import("../src/commands/chat.js");
    await chat({ system: "be terse", promptFlag: "Hi" });
    const args = chatCompletion.mock.calls[0]?.[0] as { messages: unknown };
    expect(args.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "Hi" },
    ]);
  });

  it("returns 1 on empty prompt", async () => {
    // Simulate a TTY so the command doesn't try to read piped stdin
    // (vitest runs without an actual TTY, so stdin would block indefinitely).
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const { chat } = await import("../src/commands/chat.js");
      const code = await chat({ prompt: "" });
      expect(code).toBe(1);
      expect(stderrBuf).toMatch(/Пустой prompt/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });

  it("surfaces ApiError as exit 1 with a friendly message", async () => {
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({
          chatCompletion: vi.fn(async () => {
            throw new actual.ApiError("401 Unauthorized", 401);
          }),
        })),
      };
    });
    const { chat } = await import("../src/commands/chat.js");
    const code = await chat({ prompt: "x" });
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/401/);
  });

  it("streams deltas to stdout when --stream", async () => {
    async function* fakeStream(): AsyncGenerator<unknown, void, void> {
      yield { choices: [{ delta: { content: "Hel" } }] };
      yield { choices: [{ delta: { content: "lo" } }] };
    }
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({
          chatCompletionStream: () => fakeStream(),
        })),
      };
    });
    const { chat } = await import("../src/commands/chat.js");
    const code = await chat({ prompt: "x", stream: true });
    expect(code).toBe(0);
    expect(stdoutBuf).toBe("Hello\n");
  });
});
