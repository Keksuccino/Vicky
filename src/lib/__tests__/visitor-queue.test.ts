import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

type VisitorsModule = typeof import("@/lib/visitors");

const createRequest = (ip = "203.0.113.8"): NextRequest => ({ headers: new Headers(), ip }) as unknown as NextRequest;

const page = { path: "/guide", slug: "guide", title: "Guide" };
let visitorsModule: VisitorsModule | null = null;

describe("visitor analytics write queue", () => {
  afterEach(() => {
    visitorsModule?.resetVisitorVisitQueueForTests();
    visitorsModule?.setVisitorStorageLoaderForTests(null);
    visitorsModule = null;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("applies a hard capacity bound and bounded in-memory event deduplication", async () => {
    vi.stubEnv("VISITOR_ANALYTICS_QUEUE_CAPACITY", "1");
    vi.resetModules();
    visitorsModule = await import("@/lib/visitors");

    let finishWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const recordVisitorEvent = vi.fn(() => pendingWrite.then(() => true));
    visitorsModule.setVisitorStorageLoaderForTests(async () => ({
      getVisitorAnalyticsSalt: async () => "private-salt",
      loadVisitorStatsSummary: vi.fn(),
      recordVisitorEvent,
    }));

    const request = createRequest();
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-1")).toEqual({ status: "queued" });
    await vi.waitFor(() => expect(recordVisitorEvent).toHaveBeenCalledOnce());
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-1")).toEqual({ status: "duplicate" });
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-2")).toEqual({ status: "full", retryAfterSeconds: 1 });

    finishWrite();
    await recordVisitorEvent.mock.results[0].value;
    await Promise.resolve();
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-2")).toEqual({ status: "queued" });
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-1")).toEqual({ status: "duplicate" });
    await vi.waitFor(() => expect(recordVisitorEvent).toHaveBeenCalledTimes(2));
  });

  it("backs failed writes off exponentially and stops after three attempts", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-18T10:00:00.000Z") });
    vi.stubEnv("VISITOR_ANALYTICS_RETRY_BASE_MS", "100");
    vi.stubEnv("VISITOR_ANALYTICS_RETRY_MAX_MS", "1000");
    vi.resetModules();
    visitorsModule = await import("@/lib/visitors");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const recordVisitorEvent = vi.fn().mockRejectedValueOnce(new Error("database busy")).mockRejectedValueOnce(new Error("database still busy")).mockRejectedValueOnce(new Error("database unavailable"));
    visitorsModule.setVisitorStorageLoaderForTests(async () => ({
      getVisitorAnalyticsSalt: async () => "private-salt",
      loadVisitorStatsSummary: vi.fn(),
      recordVisitorEvent,
    }));

    expect(visitorsModule.enqueueDocPageVisit(createRequest(), page, "retry-event")).toEqual({ status: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordVisitorEvent).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(recordVisitorEvent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recordVisitorEvent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(recordVisitorEvent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(recordVisitorEvent).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recordVisitorEvent).toHaveBeenCalledTimes(3);
  });

  it("expires completed in-memory dedup entries while durable SQLite dedup remains authoritative", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-18T10:00:00.000Z") });
    vi.resetModules();
    visitorsModule = await import("@/lib/visitors");

    const recordVisitorEvent = vi.fn().mockResolvedValue(true);
    visitorsModule.setVisitorStorageLoaderForTests(async () => ({ getVisitorAnalyticsSalt: async () => "private-salt", loadVisitorStatsSummary: vi.fn(), recordVisitorEvent }));

    const request = createRequest();
    expect(visitorsModule.enqueueDocPageVisit(request, page, "expiring-event")).toEqual({ status: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordVisitorEvent).toHaveBeenCalledOnce();
    expect(visitorsModule.enqueueDocPageVisit(request, page, "expiring-event")).toEqual({ status: "duplicate" });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 30_000);
    expect(visitorsModule.enqueueDocPageVisit(request, page, "expiring-event")).toEqual({ status: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordVisitorEvent).toHaveBeenCalledTimes(2);
  });
});
