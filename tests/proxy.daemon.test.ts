/**
 * tests/proxy.daemon.test.ts — PID-file lifecycle + isAlive sanity.
 *
 * We don't actually spawn a child here (that would make tests flaky in CI);
 * we test the FS / signal helpers in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAlive,
  readState,
  writeState,
  clearState,
  readLiveState,
} from "../src/lib/proxy/daemon.js";

let tmp: string;
let origHome: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "brikko-test-"));
  // Redirect HOME so paths.ts writes inside our tmpdir.
  origHome = process.env["HOME"];
  process.env["HOME"] = tmp;
  // Windows uses USERPROFILE.
  process.env["USERPROFILE"] = tmp;
});

afterEach(async () => {
  if (origHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHome;
  await rm(tmp, { recursive: true, force: true });
});

describe("isAlive", () => {
  it("returns true for our own PID", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("returns false for a clearly-dead PID", () => {
    // PID 999999 is exceedingly unlikely to be a real process.
    expect(isAlive(999_999)).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isAlive(0)).toBe(false);
    expect(isAlive(-1)).toBe(false);
    expect(isAlive(Number.NaN)).toBe(false);
  });
});

describe("PID-file round-trip", () => {
  it("writeState → readState round-trips", async () => {
    await writeState({
      pid: process.pid,
      port: 11434,
      apiBase: "https://api.brikko.test",
      piiProtect: true,
      startedAt: 1700000000000,
      cliVersion: "0.3.0",
    });
    const got = await readState();
    expect(got).toMatchObject({
      pid: process.pid,
      port: 11434,
      apiBase: "https://api.brikko.test",
      piiProtect: true,
      cliVersion: "0.3.0",
    });
  });

  it("readLiveState returns null and cleans up if the PID is dead", async () => {
    await writeState({
      pid: 999_999, // dead
      port: 11434,
      apiBase: "https://api.brikko.test",
      piiProtect: true,
      startedAt: 1700000000000,
      cliVersion: "0.3.0",
    });
    const got = await readLiveState();
    expect(got).toBeNull();
    // Stale state file should be wiped.
    const after = await readState();
    expect(after).toBeNull();
  });

  it("readLiveState returns state when the PID is alive", async () => {
    await writeState({
      pid: process.pid,
      port: 11434,
      apiBase: "https://api.brikko.test",
      piiProtect: true,
      startedAt: 1700000000000,
      cliVersion: "0.3.0",
    });
    const got = await readLiveState();
    expect(got).not.toBeNull();
    expect(got!.pid).toBe(process.pid);
  });

  it("clearState is idempotent", async () => {
    await clearState();
    await clearState();
    const got = await readState();
    expect(got).toBeNull();
  });

  it("returns null when no state file exists", async () => {
    const got = await readState();
    expect(got).toBeNull();
  });

  it("PID file content is just the integer", async () => {
    await writeState({
      pid: 42424,
      port: 11434,
      apiBase: "https://api.brikko.test",
      piiProtect: true,
      startedAt: 1700000000000,
      cliVersion: "0.3.0",
    });
    const pidContent = await readFile(join(tmp, ".brikko", "proxy.pid"), "utf8");
    expect(pidContent.trim()).toBe("42424");
  });
});
