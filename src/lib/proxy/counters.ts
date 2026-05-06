/**
 * In-memory request counters for the proxy daemon.
 *
 * Surfaced via:
 *   - GET /healthz                     — embedded in the body
 *   - GET /__brikko/stats              — admin endpoint (loopback-only)
 *   - `brikko proxy status`            — read via /__brikko/stats
 *
 * No persistence: counters reset on daemon restart (V0.3). Adding a Redis
 * or sqlite snapshot is V0.4+ work — for a single-process MVP, in-memory
 * is plenty and avoids the deploy complexity of a sidecar store.
 *
 * Thread-safety: Node.js is single-threaded for JS, so plain integer
 * increments are atomic w.r.t. each other. We don't bother with locks.
 */

export interface ProxyCounters {
  startedAt: number; // unix ms
  requests: number;
  requestsByStatus: Record<string, number>; // "2xx" | "4xx" | "5xx"
  errors: number; // upstream/network errors that resulted in 5xx
  masks: number; // /v1/anonymize calls we made on behalf of the user
  bytesIn: number;
  bytesOut: number;
  upstreamMs: number; // cumulative ms spent waiting on upstream
}

export interface CountersHandle {
  snapshot(): ProxyCounters;
  recordRequest(status: number, bytesIn: number, bytesOut: number, upstreamMs: number): void;
  recordError(): void;
  recordMask(): void;
}

export function createCounters(): CountersHandle {
  const c: ProxyCounters = {
    startedAt: Date.now(),
    requests: 0,
    requestsByStatus: {},
    errors: 0,
    masks: 0,
    bytesIn: 0,
    bytesOut: 0,
    upstreamMs: 0,
  };

  function bucket(status: number): string {
    if (status >= 500) return "5xx";
    if (status >= 400) return "4xx";
    if (status >= 300) return "3xx";
    if (status >= 200) return "2xx";
    return "1xx";
  }

  return {
    snapshot: () => ({
      ...c,
      requestsByStatus: { ...c.requestsByStatus },
    }),
    recordRequest: (status, bytesIn, bytesOut, upstreamMs) => {
      c.requests += 1;
      const key = bucket(status);
      c.requestsByStatus[key] = (c.requestsByStatus[key] ?? 0) + 1;
      c.bytesIn += bytesIn;
      c.bytesOut += bytesOut;
      c.upstreamMs += upstreamMs;
    },
    recordError: () => {
      c.errors += 1;
    },
    recordMask: () => {
      c.masks += 1;
    },
  };
}
