import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  loadPage: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
  setCacheTtl: vi.fn(),
}));

vi.mock("@/lib/cache", () => ({ setDocsCacheTtlMs: mocks.setCacheTtl }));
vi.mock("@/lib/docs-server-data", () => ({ loadDocsPageForLanguage: mocks.loadPage }));
vi.mock("@/lib/github", () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { GET as getRawDoc } from "@/app/api/docs/raw/route";
import { GET as getRawDocBySlug } from "@/app/api/docs/raw/[...slug]/route";
import { ApiError } from "@/lib/http";

const store = {
  settings: {
    autoTranslate: { languages: [] },
    docsCacheTtlMs: 60_000,
    github: {},
  },
};

const createRequest = (path = "/api/docs/raw?slug=guide"): NextRequest => new NextRequest(`https://docs.example.com${path}`);

describe("public raw docs error responses", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getStore.mockResolvedValue(store);
    mocks.resolveRuntimeConfig.mockReturnValue({ branch: "main", docsPath: "docs", owner: "owner", repo: "repo", token: "token" });
    mocks.loadPage.mockResolvedValue({ data: { markdown: "# Guide" } });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("sanitizes unexpected query-route errors while preserving plaintext response headers", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    mocks.loadPage.mockRejectedValueOnce(new Error(`GitHub request failed authorization=Bearer ${secret}`));

    const response = await getRawDoc(createRequest());

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("GET /api/docs/raw");
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("[REDACTED]");
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
  });

  it("exposes known query-route ApiErrors and their response headers", async () => {
    mocks.loadPage.mockRejectedValueOnce(new ApiError(429, "Too many document requests. Try again shortly.", { "Retry-After": "12" }));

    const response = await getRawDoc(createRequest());

    expect(response.status).toBe(429);
    expect(await response.text()).toBe("Too many document requests. Try again shortly.");
    expect(response.headers.get("retry-after")).toBe("12");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("preserves the public not-found status and message", async () => {
    mocks.loadPage.mockRejectedValueOnce(new ApiError(404, "Document not found."));

    const response = await getRawDoc(createRequest());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Document not found.");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("sanitizes non-Error throws from the catch-all slug route without inspecting attached headers", async () => {
    const secret = "slug-route-secret";
    mocks.loadPage.mockRejectedValueOnce({ headers: { authorization: `Bearer ${secret}` }, message: `failed with ${secret}` });

    const response = await getRawDocBySlug(createRequest("/api/docs/raw/guide"), { params: Promise.resolve({ slug: ["guide"] }) });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("Non-Error throw: [object]");
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
  });

  it("keeps catch-all slug validation failures useful and quiet", async () => {
    const response = await getRawDocBySlug(createRequest("/api/docs/raw/"), { params: Promise.resolve({ slug: [] }) });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("A slug query parameter is required.");
    expect(mocks.getStore).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
