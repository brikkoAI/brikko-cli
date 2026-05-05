/**
 * Tests for src/lib/config.ts — .env round-trip + path helpers + port validation.
 * No filesystem is touched here; readBrikkoEnv/writeBrikkoEnv are exercised
 * through a tmpdir in the integration test below.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnv,
  serializeEnv,
  readBrikkoEnv,
  writeBrikkoEnv,
  isValidPort,
  envPath,
  composePath,
  DEFAULT_PORT,
  DEFAULT_VERSION,
} from "../src/lib/config.js";

describe("parseEnv", () => {
  it("parses simple KEY=VALUE pairs", () => {
    expect(parseEnv("FOO=bar\nBAZ=qux\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores comments and blank lines", () => {
    expect(parseEnv("# comment\n\nFOO=bar\n# another\n")).toEqual({ FOO: "bar" });
  });

  it("strips matching double quotes", () => {
    expect(parseEnv('FOO="hello world"\n')).toEqual({ FOO: "hello world" });
  });

  it("strips matching single quotes", () => {
    expect(parseEnv("FOO='hello world'\n")).toEqual({ FOO: "hello world" });
  });

  it("does not strip mismatched quotes", () => {
    expect(parseEnv("FOO=\"unclosed\n")).toEqual({ FOO: '"unclosed' });
  });

  it("rejects keys with non-identifier chars", () => {
    expect(parseEnv("BAD-KEY=value\nGOOD_KEY=value\n")).toEqual({ GOOD_KEY: "value" });
  });

  it("ignores lines without =", () => {
    expect(parseEnv("just a line\nFOO=bar\n")).toEqual({ FOO: "bar" });
  });

  it("preserves = inside the value", () => {
    expect(parseEnv("URL=postgres://user:pass@host/db?ssl=1\n")).toEqual({
      URL: "postgres://user:pass@host/db?ssl=1",
    });
  });

  it("handles CRLF line endings (Windows)", () => {
    expect(parseEnv("FOO=bar\r\nBAZ=qux\r\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

describe("serializeEnv", () => {
  it("emits KEY=VALUE without quotes for simple values", () => {
    expect(serializeEnv({ FOO: "bar", BAZ: "qux-123" })).toBe("FOO=bar\nBAZ=qux-123\n");
  });

  it("quotes values with spaces", () => {
    expect(serializeEnv({ MSG: "hello world" })).toBe('MSG="hello world"\n');
  });

  it("escapes inner double quotes", () => {
    expect(serializeEnv({ MSG: 'a "quoted" thing' })).toBe('MSG="a \\"quoted\\" thing"\n');
  });

  it("preserves URLs without quoting", () => {
    expect(serializeEnv({ URL: "https://api.brikko.ru" })).toBe("URL=https://api.brikko.ru\n");
  });

  it("emits empty values cleanly", () => {
    expect(serializeEnv({ EMPTY: "" })).toBe("EMPTY=\n");
  });
});

describe("isValidPort", () => {
  it("accepts 1..65535", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(3737)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });
  it("rejects out-of-range and non-integers", () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(3.14)).toBe(false);
    expect(isValidPort(Number.NaN)).toBe(false);
  });
});

describe("path helpers", () => {
  it("envPath joins installDir and .env", () => {
    expect(envPath("/foo")).toBe(join("/foo", ".env"));
  });
  it("composePath joins installDir and docker-compose.yml", () => {
    expect(composePath("/foo")).toBe(join("/foo", "docker-compose.yml"));
  });
});

describe("readBrikkoEnv / writeBrikkoEnv (filesystem round-trip)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "brikko-cli-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when .env is missing", async () => {
    const env = await readBrikkoEnv(dir);
    expect(env.port).toBe(DEFAULT_PORT);
    expect(env.version).toBe(DEFAULT_VERSION);
    expect(env.gateway).toBe("https://api.brikko.ru");
  });

  it("round-trips writeBrikkoEnv → readBrikkoEnv", async () => {
    await writeBrikkoEnv(dir, { port: 3838, version: "0.3.0" });
    const env = await readBrikkoEnv(dir);
    expect(env.port).toBe(3838);
    expect(env.version).toBe("0.3.0");
  });

  it("preserves extra keys via extraRaw", async () => {
    await writeBrikkoEnv(
      dir,
      { port: 3737 },
      { CUSTOM_KEY: "value", BRIKKO_PLUGIN_DEBUG: "1" },
    );
    const env = await readBrikkoEnv(dir);
    expect(env.raw["CUSTOM_KEY"]).toBe("value");
    expect(env.raw["BRIKKO_PLUGIN_DEBUG"]).toBe("1");
  });

  it("falls back to default port if .env has garbage value", async () => {
    await writeFile(envPath(dir), "BRIKKO_PORT=not-a-number\n", "utf8");
    const env = await readBrikkoEnv(dir);
    expect(env.port).toBe(DEFAULT_PORT);
  });

  it("writeBrikkoEnv overwrites existing .env", async () => {
    await writeFile(envPath(dir), "BRIKKO_PORT=9999\nFOO=bar\n", "utf8");
    await writeBrikkoEnv(dir, { port: 3737 });
    const content = await readFile(envPath(dir), "utf8");
    expect(content).toContain("BRIKKO_PORT=3737");
  });
});
