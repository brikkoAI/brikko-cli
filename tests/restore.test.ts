/**
 * tests/restore.test.ts — `brikko restore` command.
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

describe("brikko restore", () => {
  it("requires --mapping-id", async () => {
    const { restore } = await import("../src/commands/restore.js");
    const code = await restore({ text: "<NAME_1>" });
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/mapping-id/);
  });

  it("prints restored_text to stdout", async () => {
    const restoreMock = vi.fn(async () => ({ restored_text: "Иванов подписал" }));
    vi.doMock("../src/lib/api.js", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/api.js")>(
        "../src/lib/api.js",
      );
      return {
        ...actual,
        BrikkoApiClient: vi.fn().mockImplementation(() => ({ restore: restoreMock })),
      };
    });
    const { restore } = await import("../src/commands/restore.js");
    const code = await restore({ mappingId: "abc", text: "<NAME_1> подписал" });
    expect(code).toBe(0);
    expect(stdoutBuf).toBe("Иванов подписал\n");
    expect(restoreMock).toHaveBeenCalledWith(
      "<NAME_1> подписал",
      "abc",
      expect.anything(),
    );
  });

  it("returns 1 on empty input", async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const { restore } = await import("../src/commands/restore.js");
      const code = await restore({ mappingId: "abc", text: "  " });
      expect(code).toBe(1);
      expect(stderrBuf).toMatch(/Пустой текст/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });
});
