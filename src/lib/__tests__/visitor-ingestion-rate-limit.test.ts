import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const createRequest = (ip: string): NextRequest => ({ headers: new Headers(), ip }) as unknown as NextRequest;

describe("visitor analytics admission limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("enforces deterministic per-client, global, and concurrency limits", async () => {
    vi.stubEnv("VISITOR_ANALYTICS_CLIENT_MAX_REQUESTS", "2");
    vi.stubEnv("VISITOR_ANALYTICS_GLOBAL_MAX_REQUESTS", "4");
    vi.stubEnv("VISITOR_ANALYTICS_RATE_WINDOW_SECONDS", "10");
    vi.stubEnv("VISITOR_ANALYTICS_CLIENT_MAX_CONCURRENCY", "1");
    vi.stubEnv("VISITOR_ANALYTICS_GLOBAL_MAX_CONCURRENCY", "2");
    vi.resetModules();

    const { acquireVisitorIngestionPermit } = await import("@/lib/visitor-ingestion-rate-limit");
    const clientA = createRequest("203.0.113.1");
    const clientB = createRequest("203.0.113.2");
    const first = acquireVisitorIngestionPermit(clientA, 1_000);
    const concurrent = acquireVisitorIngestionPermit(clientA, 1_000);
    const parallelClient = acquireVisitorIngestionPermit(clientB, 1_000);
    const globallyConcurrent = acquireVisitorIngestionPermit(createRequest("203.0.113.3"), 1_000);

    expect(first.allowed).toBe(true);
    expect(concurrent).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(parallelClient.allowed).toBe(true);
    expect(globallyConcurrent).toEqual({ allowed: false, retryAfterSeconds: 1 });
    if (first.allowed) {
      first.release();
    }
    if (parallelClient.allowed) {
      parallelClient.release();
    }

    const second = acquireVisitorIngestionPermit(clientA, 1_000);
    expect(second.allowed).toBe(true);
    if (second.allowed) {
      second.release();
    }
    expect(acquireVisitorIngestionPermit(clientA, 1_000)).toEqual({ allowed: false, retryAfterSeconds: 10 });

    const fourth = acquireVisitorIngestionPermit(createRequest("203.0.113.3"), 1_000);
    expect(fourth.allowed).toBe(true);
    if (fourth.allowed) {
      fourth.release();
    }
    expect(acquireVisitorIngestionPermit(createRequest("203.0.113.4"), 1_000)).toEqual({ allowed: false, retryAfterSeconds: 10 });

    const afterWindow = acquireVisitorIngestionPermit(clientA, 11_000);
    expect(afterWindow.allowed).toBe(true);
    if (afterWindow.allowed) {
      afterWindow.release();
    }
  });
});
