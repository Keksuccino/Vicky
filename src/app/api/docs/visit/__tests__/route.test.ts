import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  acquirePermit: vi.fn(),
  enqueueVisit: vi.fn(),
  getCachedPage: vi.fn(),
  getStore: vi.fn(),
  listTree: vi.fn(),
  releasePermit: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
  setCacheTtl: vi.fn(),
}));

vi.mock("@/lib/cache", () => ({ setDocsCacheTtlMs: mocks.setCacheTtl }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/visitor-ingestion-rate-limit", () => ({ acquireVisitorIngestionPermit: mocks.acquirePermit }));
vi.mock("@/lib/github", () => ({
  getCachedGitHubDocPage: mocks.getCachedPage,
  listMarkdownDocsTree: mocks.listTree,
  resolveRuntimeConfig: mocks.resolveRuntimeConfig,
}));
vi.mock("@/lib/visitors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/visitors")>()),
  enqueueDocPageVisit: mocks.enqueueVisit,
}));

import { POST } from "@/app/api/docs/visit/route";

const validPayload = {
  eventId: "123e4567-e89b-12d3-a456-426614174000",
  path: "/guide/getting-started",
  slug: "guide/getting-started",
};

const createRequest = (body: unknown, headers: Record<string, string> = {}): NextRequest => new NextRequest("https://docs.example.com/api/docs/visit", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    host: "docs.example.com",
    origin: "https://docs.example.com",
    "sec-fetch-site": "same-origin",
    ...headers,
  },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("POST /api/docs/visit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquirePermit.mockReturnValue({ allowed: true, release: mocks.releasePermit });
    mocks.enqueueVisit.mockReturnValue({ status: "queued" });
    mocks.getStore.mockResolvedValue({ settings: { docsCacheTtlMs: 60_000, github: {} } });
    mocks.resolveRuntimeConfig.mockReturnValue({ owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: "token" });
    mocks.listTree.mockResolvedValue([{ path: "guide/getting-started.md", slug: "guide/getting-started", name: "Tree Title" }]);
    mocks.getCachedPage.mockReturnValue({ title: "Authoritative Cached Title" });
  });

  it("queues only a server-resolved known page and ignores a legacy client title", async () => {
    const response = await POST(createRequest({ ...validPayload, title: "Client-controlled title" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ duplicate: false, queued: true });
    expect(mocks.enqueueVisit).toHaveBeenCalledWith(expect.any(NextRequest), {
      path: "/guide/getting-started",
      slug: "guide/getting-started",
      title: "Authoritative Cached Title",
    }, validPayload.eventId);
    expect(mocks.releasePermit).toHaveBeenCalledOnce();
  });

  it("rejects nonexistent pages and mismatched canonical paths", async () => {
    mocks.listTree.mockResolvedValueOnce([]);
    const missingResponse = await POST(createRequest(validPayload));
    const mismatchedResponse = await POST(createRequest({ ...validPayload, path: "/guide/other" }));

    expect(missingResponse.status).toBe(404);
    expect(mismatchedResponse.status).toBe(400);
    expect(mocks.enqueueVisit).not.toHaveBeenCalled();
    expect(mocks.releasePermit).toHaveBeenCalledTimes(2);
  });

  it("enforces content type, body size, schema, and safe path characters before docs lookup", async () => {
    const contentTypeResponse = await POST(createRequest(validPayload, { "content-type": "text/plain" }));
    const oversizedResponse = await POST(createRequest(`{"padding":"${"x".repeat(2_100)}"}`));
    const invalidEventResponse = await POST(createRequest({ ...validPayload, eventId: "x".repeat(65) }));
    const traversalResponse = await POST(createRequest({ ...validPayload, path: "/guide/../secret", slug: "guide/../secret" }));
    const unsafeTitleResponse = await POST(createRequest({ ...validPayload, title: "Spoofed\ntitle" }));
    const extraFieldResponse = await POST(createRequest({ ...validPayload, unexpected: true }));

    expect(contentTypeResponse.status).toBe(415);
    expect(oversizedResponse.status).toBe(413);
    expect(invalidEventResponse.status).toBe(400);
    expect(traversalResponse.status).toBe(400);
    expect(unsafeTitleResponse.status).toBe(400);
    expect(extraFieldResponse.status).toBe(400);
    expect(mocks.listTree).not.toHaveBeenCalled();
    expect(mocks.releasePermit).toHaveBeenCalledTimes(6);
  });

  it("rejects cross-site requests and exposes Retry-After for admission limits", async () => {
    const crossSiteResponse = await POST(createRequest(validPayload, { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }));
    mocks.acquirePermit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 17 });
    const limitedResponse = await POST(createRequest(validPayload));

    expect(crossSiteResponse.status).toBe(403);
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("retry-after")).toBe("17");
    expect(mocks.listTree).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the bounded write queue is full", async () => {
    mocks.enqueueVisit.mockReturnValueOnce({ status: "full", retryAfterSeconds: 5 });
    const response = await POST(createRequest(validPayload));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: "Analytics queue is full. Please try again later.", retryAfterSeconds: 5 });
    expect(mocks.releasePermit).toHaveBeenCalledOnce();
  });
});
