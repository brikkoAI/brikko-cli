/**
 * tests/proxy.counters.test.ts — in-memory counters used by the proxy.
 */

import { describe, expect, it } from "vitest";
import { createCounters } from "../src/lib/proxy/counters.js";

describe("createCounters", () => {
  it("starts with zeros and a startedAt timestamp", () => {
    const c = createCounters();
    const snap = c.snapshot();
    expect(snap.requests).toBe(0);
    expect(snap.errors).toBe(0);
    expect(snap.masks).toBe(0);
    expect(snap.bytesIn).toBe(0);
    expect(snap.bytesOut).toBe(0);
    expect(snap.upstreamMs).toBe(0);
    expect(snap.startedAt).toBeGreaterThan(0);
  });

  it("buckets statuses correctly", () => {
    const c = createCounters();
    c.recordRequest(200, 0, 100, 50);
    c.recordRequest(204, 0, 0, 10);
    c.recordRequest(404, 0, 30, 20);
    c.recordRequest(503, 0, 50, 80);
    const snap = c.snapshot();
    expect(snap.requests).toBe(4);
    expect(snap.requestsByStatus["2xx"]).toBe(2);
    expect(snap.requestsByStatus["4xx"]).toBe(1);
    expect(snap.requestsByStatus["5xx"]).toBe(1);
    expect(snap.bytesOut).toBe(180);
    expect(snap.upstreamMs).toBe(160);
  });

  it("recordError and recordMask are independent", () => {
    const c = createCounters();
    c.recordError();
    c.recordError();
    c.recordMask();
    const snap = c.snapshot();
    expect(snap.errors).toBe(2);
    expect(snap.masks).toBe(1);
  });

  it("snapshot is a defensive copy", () => {
    const c = createCounters();
    c.recordRequest(200, 0, 1, 1);
    const a = c.snapshot();
    c.recordRequest(200, 0, 1, 1);
    const b = c.snapshot();
    expect(a.requests).toBe(1);
    expect(b.requests).toBe(2);
    // Mutating the first snapshot doesn't affect later ones.
    a.requestsByStatus["2xx"] = 999;
    expect(c.snapshot().requestsByStatus["2xx"]).toBe(2);
  });
});
