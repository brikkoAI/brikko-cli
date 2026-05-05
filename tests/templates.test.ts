/**
 * Templates copy correctly from dist/templates at runtime.
 * This test runs against the BUILT package — `npm run build` must succeed
 * first. CI runs build before test, so this is automatic in the pipeline.
 *
 * For pre-build dev runs (`npm test` without `npm run build`), the test
 * is skipped if dist/ is missing.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const distDir = resolve(__dirname, "..", "dist");
const distExists = existsSync(distDir);

describe.skipIf(!distExists)("dist/templates", () => {
  it("contains docker-compose.yml", async () => {
    const path = resolve(distDir, "templates", "docker-compose.yml");
    const s = await stat(path);
    expect(s.isFile()).toBe(true);
    expect(s.size).toBeGreaterThan(100);
  });

  it("contains .env.example", async () => {
    const path = resolve(distDir, "templates", ".env.example");
    const s = await stat(path);
    expect(s.isFile()).toBe(true);
    expect(s.size).toBeGreaterThan(50);
  });

  it("docker-compose.yml references ghcr.io/brikkoai images", async () => {
    const body = await readFile(
      resolve(distDir, "templates", "docker-compose.yml"),
      "utf8",
    );
    expect(body).toContain("ghcr.io/brikkoai/studio-core");
    expect(body).toContain("ghcr.io/brikkoai/studio-anonymizer");
  });

  it("dist/cli.js has shebang + is the bin entrypoint", async () => {
    const cli = resolve(distDir, "cli.js");
    const body = await readFile(cli, "utf8");
    expect(body.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
