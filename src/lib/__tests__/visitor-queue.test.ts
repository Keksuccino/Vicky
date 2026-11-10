import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { INTERNAL_CLIENT_IP_HEADER } from "@/lib/client-ip-policy";
import { INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER } from "@/lib/request-origin-policy.mjs";
import type { VisitorEventInput } from "@/lib/types";

type VisitorsModule = typeof import("@/lib/visitors");

const createRequest = (ip = "203.0.113.8"): NextRequest => ({ headers: new Headers(), ip }) as unknown as NextRequest;
const createHeaderRequest = (headers: Record<string, string> = {}): NextRequest => ({ headers: new Headers(headers) }) as unknown as NextRequest;
const createTrustedProxyRequest = (clientIp: string): NextRequest => createHeaderRequest({ "x-forwarded-for": clientIp, [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: "visitor-queue-token", [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" });

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
    const recordVisitorEvents = vi.fn((events: VisitorEventInput[]) => pendingWrite.then(() => ({ duplicates: 0, recorded: events.length })));
    visitorsModule.setVisitorStorageLoaderForTests(async () => ({
      getVisitorAnalyticsSalt: async () => "private-salt",
      loadVisitorAnalytics: vi.fn(),
      recordVisitorEvents,
    }));

    const request = createRequest();
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-1")).toEqual({ status: "queued" });
    await vi.waitFor(() => expect(recordVisitorEvents).toHaveBeenCalledOnce());
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-1")).toEqual({ status: "duplicate" });
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-2")).toEqual({ status: "full", retryAfterSeconds: 1 });

    finishWrite();
    await recordVisitorEvents.mock.results[0].value;
    await Promise.resolve();
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-2")).toEqual({ status: "queued" });
    expect(visitorsModule.enqueueDocPageVisit(request, page, "event-1")).toEqual({ status: "duplicate" });
    await vi.waitFor(() => expect(recordVisitorEvents).toHaveBeenCalledTimes(2));
  });

  it("writes the visits that queued up during a write together in the next batch", async () => {
    vi.resetModules();
    visitorsModule = await import("@/lib/visitors");

    let finishFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      finishFirstWrite = resolve;
    });
    const recordVisitorEvents = vi.fn((events: VisitorEventInput[]) => (recordVisitorEvents.mock.calls.length === 1 ? firstWrite : Promise.resolve()).then(() => ({ duplicates: 0, recorded: events.length })));
    visitorsModule.setVisitorStorageLoaderForTests(async () => ({ getVisitorAnalyticsSalt: async () => "private-salt", loadVisitorAnalytics: vi.fn(), recordVisitorEvents }));

    expect(visitorsModule.enqueueDocPageVisit(createRequest("203.0.113.1"), page, "first")).toEqual({ status: "queued" });
    await vi.waitFor(() => expect(recordVisitorEvents).toHaveBeenCalledOnce());
    for (const [index, eventId] of ["second", "third", "fourth"].entries()) {
      expect(visitorsModule.enqueueDocPageVisit(createRequest(`203.0.113.${index + 2}`), page, eventId)).toEqual({ status: "queued" });
    }

    finishFirstWrite();
    await vi.waitFor(() => expect(recordVisitorEvents).toHaveBeenCalledTimes(2));
    expect(recordVisitorEvents.mock.calls[1][0].map((event) => event.eventId)).toEqual(["second", "third", "fourth"]);
  });

  it("backs failed writes off exponentially and stops after three attempts", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-18T10:00:00.000Z") });
    vi.stubEnv("VISITOR_ANALYTICS_RETRY_BASE_MS", "100");
    vi.stubEnv("VISITOR_ANALYTICS_RETRY_MAX_MS", "1000");
    vi.resetModules();
    visitorsModule = await import("@/lib/visitors");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const recordVisitorEvents = vi.fn().mockRejectedValueOnce(new Error("database busy")).mockRejectedValueOnce(new Error("database still busy")).mockRejectedValueOnce(new Error("database unavailable"));
    visitorsModule.setVisitorStorageLoaderForTests(async () => ({
      getVisitorAnalyticsSalt: async () => "private-salt",
      loadVisitorAnalytics: vi.fn(),
      recordVisitorEvents,
    }));

    expect(visitorsModule.enqueueDocPageVisit(createRequest(), page, "retry-event")).toEqual({ status: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordVisitorEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(recordVisitorEvents).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recordVisitorEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(recordVisitorEvents).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(recordVisitorEvents).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recordVisitorEvents).toHaveBeenCalledTimes(3);
  });

  it("expires completed in-memory dedup entries while durable SQLite dedup remains authoritative", async () => {
    vi.useFakeTimers({ now: new Date("2026-08-18T10:00:00.000Z") });
    vi.resetModules();
    visitorsModule = await import("@/lib/visitors");

    const recordVisitorEvents = vi.fn().mockResolvedValue({ duplicates: 0, recorded: 1 });
    visitorsModule.setVisitorStorageLoaderForTests(async () => ({ getVisitorAnalyticsSalt: async () => "private-salt", loadVisitorAnalytics: vi.fn(), recordVisitorEvents }));

    const request = createRequest();
    expect(visitorsModule.enqueueDocPageVisit(request, page, "expiring-event")).toEqual({ status: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordVisitorEvents).toHaveBeenCalledOnce();
    expect(visitorsModule.enqueueDocPageVisit(request, page, "expiring-event")).toEqual({ status: "duplicate" });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000 + 30_000);
    expect(visitorsModule.enqueueDocPageVisit(request, page, "expiring-event")).toEqual({ status: "queued" });
    await vi.advanceTimersByTimeAsync(0);
    expect(recordVisitorEvents).toHaveBeenCalledTimes(2);
  });

  it("deduplicates per trusted client without collapsing distinct or unknown clients", async () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "visitor-queue-token");
    vi.resetModules();
    visitorsModule = await import("@/lib/visitors");

    const recordVisitorEvents = vi.fn().mockResolvedValue({ duplicates: 0, recorded: 1 });
    visitorsModule.setVisitorStorageLoaderForTests(async () => ({ getVisitorAnalyticsSalt: async () => "private-salt", loadVisitorAnalytics: vi.fn(), recordVisitorEvents }));

    expect(visitorsModule.enqueueDocPageVisit(createTrustedProxyRequest("198.51.100.20"), page, "shared-event")).toEqual({ status: "queued" });
    expect(visitorsModule.enqueueDocPageVisit(createTrustedProxyRequest("198.51.100.20"), page, "shared-event")).toEqual({ status: "duplicate" });
    expect(visitorsModule.enqueueDocPageVisit(createTrustedProxyRequest("198.51.100.21"), page, "shared-event")).toEqual({ status: "queued" });
    expect(visitorsModule.enqueueDocPageVisit(createHeaderRequest(), page, "shared-event")).toEqual({ status: "queued" });
    expect(visitorsModule.enqueueDocPageVisit(createHeaderRequest(), page, "shared-event")).toEqual({ status: "queued" });
    const recordedEvents = (): VisitorEventInput[] => recordVisitorEvents.mock.calls.flatMap(([events]) => events as VisitorEventInput[]);
    await vi.waitFor(() => expect(recordedEvents()).toHaveLength(4));

    const visitorIds = recordedEvents().map((event) => event.visitorId);
    expect(new Set(visitorIds).size).toBe(4);
  });
});
