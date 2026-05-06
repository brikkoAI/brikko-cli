/**
 * tests/auth.test.ts — covers ~/.brikko/config.json read/write, key shape
 * validation, and the resolveAuth precedence (flag > env > file > prompt).
 *
 * We isolate $HOME via a tmpdir + vi.stubEnv so the real config is untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import {
  AuthError,
  DEFAULT_API_BASE,
  looksLikeApiKey,
  readUserConfig,
  resolveAuth,
  userConfigPath,
  writeUserConfig,
} from "../src/lib/auth.js";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "brikko-home-"));
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("USERPROFILE", homeDir); // Windows
  // Wipe any inherited Brikko vars so each test starts from a clean slate.
  vi.stubEnv("BRIKKO_API_KEY", "");
  vi.stubEnv("BRIKKO_API_BASE", "");
  vi.stubEnv("BRIKKO_GATEWAY", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true });
});

describe("looksLikeApiKey", () => {
  it("accepts sk-brk-... shaped keys", () => {
    expect(looksLikeApiKey("sk-brk-abcdef1234")).toBe(true);
    expect(looksLikeApiKey("sk-test-1234567890")).toBe(true);
  });
  it("rejects obviously bad shapes", () => {
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("password123")).toBe(false);
    expect(looksLikeApiKey("sk-")).toBe(false);
  });
});

describe("user config round-trip", () => {
  it("returns empty when file missing", async () => {
    expect(await readUserConfig()).toEqual({});
  });

  it("writes then reads", async () => {
    await writeUserConfig({ apiKey: "sk-brk-xyz1234567", apiBase: "https://api.brikko.ru" });
    expect(existsSync(userConfigPath())).toBe(true);
    const cfg = await readUserConfig();
    expect(cfg.apiKey).toBe("sk-brk-xyz1234567");
    expect(cfg.apiBase).toBe("https://api.brikko.ru");
  });

  it("ignores corrupt JSON", async () => {
    await writeUserConfig({ apiKey: "sk-brk-xyz1234567" });
    // Corrupt the file
    const path = userConfigPath();
    await import("node:fs/promises").then((m) => m.writeFile(path, "{not json", "utf8"));
    expect(await readUserConfig()).toEqual({});
  });
});

describe("resolveAuth precedence", () => {
  it("uses --key flag first", async () => {
    vi.stubEnv("BRIKKO_API_KEY", "sk-brk-from-env");
    await writeUserConfig({ apiKey: "sk-brk-from-file" });
    const r = await resolveAuth({ key: "sk-brk-from-flag" });
    expect(r.apiKey).toBe("sk-brk-from-flag");
    expect(r.source).toBe("flag");
  });

  it("falls back to BRIKKO_API_KEY env", async () => {
    vi.stubEnv("BRIKKO_API_KEY", "sk-brk-from-env");
    await writeUserConfig({ apiKey: "sk-brk-from-file" });
    const r = await resolveAuth();
    expect(r.apiKey).toBe("sk-brk-from-env");
    expect(r.source).toBe("env");
  });

  it("falls back to ~/.brikko/config.json", async () => {
    await writeUserConfig({ apiKey: "sk-brk-from-file" });
    const r = await resolveAuth();
    expect(r.apiKey).toBe("sk-brk-from-file");
    expect(r.source).toBe("file");
  });

  it("throws AuthError when nothing available and not interactive", async () => {
    await expect(resolveAuth({ interactive: false })).rejects.toBeInstanceOf(AuthError);
  });

  it("uses default apiBase when nothing overrides it", async () => {
    await writeUserConfig({ apiKey: "sk-brk-xyz1234567" });
    const r = await resolveAuth();
    expect(r.apiBase).toBe(DEFAULT_API_BASE);
  });

  it("respects BRIKKO_API_BASE override", async () => {
    await writeUserConfig({ apiKey: "sk-brk-xyz1234567" });
    vi.stubEnv("BRIKKO_API_BASE", "https://staging.brikko.ru");
    const r = await resolveAuth();
    expect(r.apiBase).toBe("https://staging.brikko.ru");
  });

  it("falls back to BRIKKO_GATEWAY for legacy compat", async () => {
    await writeUserConfig({ apiKey: "sk-brk-xyz1234567" });
    vi.stubEnv("BRIKKO_GATEWAY", "https://legacy.brikko.ru");
    const r = await resolveAuth();
    expect(r.apiBase).toBe("https://legacy.brikko.ru");
  });

  it("apiBase from config.json wins over BRIKKO_GATEWAY but not BRIKKO_API_BASE", async () => {
    await writeUserConfig({
      apiKey: "sk-brk-xyz1234567",
      apiBase: "https://custom.brikko.ru",
    });
    vi.stubEnv("BRIKKO_GATEWAY", "https://legacy.brikko.ru");
    const r = await resolveAuth();
    expect(r.apiBase).toBe("https://custom.brikko.ru");
  });
});

describe("userConfigPath", () => {
  it("points inside the (stubbed) home directory", () => {
    const p = userConfigPath();
    // homedir() reads HOME on POSIX, USERPROFILE on Windows. Both stubbed.
    expect(p.endsWith(join(".brikko", "config.json"))).toBe(true);
  });
});

it("writeUserConfig persists a file we can read back via the file system", async () => {
  await writeUserConfig({ apiKey: "sk-brk-roundtrip-12" });
  const raw = await readFile(userConfigPath(), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  expect(parsed["apiKey"]).toBe("sk-brk-roundtrip-12");
});
