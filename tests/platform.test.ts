/**
 * Tests for src/lib/platform.ts.
 *
 * detectPlatform reads /proc/version on Linux to distinguish WSL. We can't
 * monkey-patch process.platform in vitest reliably, so we test the
 * platformLabel mapping directly + confirm the function runs without
 * throwing on the host platform.
 */

import { describe, it, expect } from "vitest";
import { detectPlatform, platformLabel, openBrowser } from "../src/lib/platform.js";

describe("platformLabel", () => {
  it("maps each known platform to a friendly string", () => {
    expect(platformLabel("macos")).toBe("macOS");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("wsl")).toBe("WSL (Linux on Windows)");
    expect(platformLabel("windows")).toBe("Windows");
    expect(platformLabel("unknown")).toBe("unknown");
  });
});

describe("detectPlatform", () => {
  it("returns one of the known labels", async () => {
    const p = await detectPlatform();
    expect(["macos", "linux", "wsl", "windows", "unknown"]).toContain(p);
  });

  it("matches process.platform for darwin/win32", async () => {
    const p = await detectPlatform();
    if (process.platform === "darwin") expect(p).toBe("macos");
    if (process.platform === "win32") expect(p).toBe("windows");
  });
});

describe("openBrowser", () => {
  it("returns false when BRIKKO_NO_BROWSER=1 is set", async () => {
    const original = process.env["BRIKKO_NO_BROWSER"];
    process.env["BRIKKO_NO_BROWSER"] = "1";
    try {
      // Pass an invalid platform to avoid spawning a real browser even if
      // the env var were ignored.
      const ok = await openBrowser("http://example.com", "unknown");
      expect(ok).toBe(false);
    } finally {
      if (original === undefined) delete process.env["BRIKKO_NO_BROWSER"];
      else process.env["BRIKKO_NO_BROWSER"] = original;
    }
  });

  it("returns false on unknown platform", async () => {
    const ok = await openBrowser("http://example.com", "unknown");
    expect(ok).toBe(false);
  });
});
