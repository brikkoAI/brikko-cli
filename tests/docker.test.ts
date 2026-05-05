/**
 * Tests for src/lib/docker.ts. We mock execa so:
 *   - no real docker calls happen during CI
 *   - we can assert the exact argv passed (this is how we catch regressions
 *     where a refactor accidentally changes `docker compose up -d` →
 *     `docker compose up`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist-aware mock of execa.
const execaMock = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => execaMock(...args),
}));

// Import AFTER mocking.
const docker = await import("../src/lib/docker.js");

beforeEach(() => {
  execaMock.mockReset();
});

describe("hasDocker", () => {
  it("returns true when `docker --version` succeeds", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "Docker version 25.0.3", exitCode: 0 });
    expect(await docker.hasDocker()).toBe(true);
    expect(execaMock).toHaveBeenCalledWith("docker", ["--version"], expect.any(Object));
  });

  it("returns false when execa rejects", async () => {
    execaMock.mockRejectedValueOnce(new Error("ENOENT"));
    expect(await docker.hasDocker()).toBe(false);
  });
});

describe("hasComposeV2", () => {
  it("returns true when `docker compose version` succeeds", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "Docker Compose v2.27.0", exitCode: 0 });
    expect(await docker.hasComposeV2()).toBe(true);
    expect(execaMock).toHaveBeenCalledWith(
      "docker",
      ["compose", "version"],
      expect.any(Object),
    );
  });

  it("returns false when execa rejects", async () => {
    execaMock.mockRejectedValueOnce(new Error("not found"));
    expect(await docker.hasComposeV2()).toBe(false);
  });
});

describe("dockerDaemonAlive", () => {
  it("returns true when `docker info` succeeds", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "Server: Docker", exitCode: 0 });
    expect(await docker.dockerDaemonAlive()).toBe(true);
    expect(execaMock).toHaveBeenCalledWith("docker", ["info"], expect.any(Object));
  });

  it("returns false when daemon is unreachable", async () => {
    execaMock.mockRejectedValueOnce(new Error("Cannot connect"));
    expect(await docker.dockerDaemonAlive()).toBe(false);
  });
});

describe("dockerVersion", () => {
  it("returns trimmed stdout", async () => {
    execaMock.mockResolvedValueOnce({ stdout: "Docker version 25.0.3, build abc\n", exitCode: 0 });
    expect(await docker.dockerVersion()).toBe("Docker version 25.0.3, build abc");
  });

  it("returns null on failure", async () => {
    execaMock.mockRejectedValueOnce(new Error("fail"));
    expect(await docker.dockerVersion()).toBeNull();
  });
});

describe("compose()", () => {
  it("invokes `docker compose <args>` with cwd", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });
    const r = await docker.compose(["up", "-d"], { cwd: "/tmp/brikko" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("ok");
    expect(execaMock).toHaveBeenCalledWith(
      "docker",
      ["compose", "up", "-d"],
      expect.objectContaining({ cwd: "/tmp/brikko" }),
    );
  });

  it("merges env vars on top of process.env", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    await docker.compose(["pull"], { cwd: "/tmp", env: { BRIKKO_VERSION: "0.3.0" } });
    expect(execaMock).toHaveBeenCalledWith(
      "docker",
      ["compose", "pull"],
      expect.objectContaining({
        env: expect.objectContaining({ BRIKKO_VERSION: "0.3.0" }),
      }),
    );
  });

  it("throws DockerError on non-zero exit", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 17, stdout: "", stderr: "boom" });
    await expect(docker.compose(["up"], { cwd: "/tmp" })).rejects.toMatchObject({
      name: "DockerError",
      kind: "exec-failed",
    });
  });

  it("wraps unexpected errors in DockerError", async () => {
    execaMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    await expect(docker.compose(["ps"], { cwd: "/tmp" })).rejects.toMatchObject({
      name: "DockerError",
      kind: "exec-failed",
    });
  });

  it("respects inherit option", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    await docker.compose(["logs", "-f"], { cwd: "/tmp", inherit: true });
    expect(execaMock).toHaveBeenCalledWith(
      "docker",
      ["compose", "logs", "-f"],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });
});

describe("parseComposePs", () => {
  it("parses NDJSON output (one obj per line)", () => {
    const stdout =
      '{"Name":"brikko-studio-core","Service":"core","State":"running","Status":"Up 2 minutes (healthy)","Health":"healthy","Image":"ghcr.io/brikkoai/studio-core:0.3.0"}\n' +
      '{"Name":"brikko-studio-redis","Service":"redis","State":"running","Status":"Up 2 minutes","Image":"redis:7.2-alpine"}\n';
    const rows = docker.parseComposePs(stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "brikko-studio-core",
      service: "core",
      state: "running",
      health: "healthy",
    });
    expect(rows[1]).toMatchObject({
      name: "brikko-studio-redis",
      service: "redis",
      state: "running",
    });
  });

  it("falls back to JSON-array parse when NDJSON fails", () => {
    const stdout = JSON.stringify([
      { Name: "a", Service: "core", State: "running", Status: "Up" },
    ]);
    const rows = docker.parseComposePs(stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.service).toBe("core");
  });

  it("returns empty array on empty input", () => {
    expect(docker.parseComposePs("")).toEqual([]);
    expect(docker.parseComposePs("\n\n")).toEqual([]);
  });

  it("skips unparseable lines (graceful degradation)", () => {
    const stdout = 'garbage\n{"Name":"a","Service":"core","State":"running","Status":"Up"}\n';
    const rows = docker.parseComposePs(stdout);
    expect(rows).toHaveLength(1);
  });
});
