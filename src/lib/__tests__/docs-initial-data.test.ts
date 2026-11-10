import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admit: vi.fn((_request: unknown, work: () => Promise<unknown>) => work()),
  buildDocTree: vi.fn(),
  firstLeafPath: vi.fn(),
  getStore: vi.fn(),
  loadPage: vi.fn(),
  loadTree: vi.fn(),
  nextHeaders: vi.fn(),
  redirect: vi.fn((location: string): never => {
    throw Object.assign(new Error("redirect"), { location });
  }),
  resolveRuntimeConfig: vi.fn(),
  setCacheTtl: vi.fn(),
  toAbsoluteDocPath: vi.fn((value: string) => value.startsWith("/") ? value : `/${value}`),
}));

vi.mock("next/headers", () => ({ headers: mocks.nextHeaders }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/api", () => ({ buildDocTree: mocks.buildDocTree, firstLeafPath: mocks.firstLeafPath, toAbsoluteDocPath: mocks.toAbsoluteDocPath }));
vi.mock("@/lib/cache", () => ({ setDocsCacheTtlMs: mocks.setCacheTtl }));
vi.mock("@/lib/docs-server-data", () => ({ loadDocsTreeForLanguage: mocks.loadTree, loadRenderedDocsPageForLanguage: mocks.loadPage }));
vi.mock("@/lib/github", () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig }));
vi.mock("@/lib/public-docs-admission", () => ({ withPublicDocsAdmission: mocks.admit }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { docsRequestPath, loadDocsRouteData, loadInitialDocsClientData } from "@/lib/docs-initial-data";
import { DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE } from "@/lib/auto-translate";
import { docsHrefForPagePath } from "@/lib/docs-routing";
import { ApiError } from "@/lib/http";

const store = {
  settings: {
    autoTranslate: { languages: [] },
    docsCacheTtlMs: 60_000,
    github: {},
  },
};

describe("initial public docs error state", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getStore.mockResolvedValue(store);
    mocks.nextHeaders.mockResolvedValue(new Headers());
    mocks.resolveRuntimeConfig.mockReturnValue({ branch: "main", docsPath: "docs", owner: "owner", repo: "repo", token: "token" });
    mocks.loadTree.mockResolvedValue({ data: [], language: { code: "default" } });
    mocks.buildDocTree.mockReturnValue([]);
    mocks.firstLeafPath.mockReturnValue(null);
    mocks.loadPage.mockResolvedValue({ data: { description: "", headings: [], includeInPlaintextExport: true, path: "guide.md", slug: "guide", sourceHeadings: [], title: "Guide" }, language: { code: "default" } });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("does not serialize an unexpected page Error.message into the client/render payload", async () => {
    const secret = "render-payload-secret";
    mocks.loadPage.mockRejectedValueOnce(new Error(`Markdown cache failed password=${secret}`));

    const result = await loadInitialDocsClientData("/guide");
    const serialized = JSON.stringify(result);

    expect(result.pageError).toEqual(expect.any(String));
    expect(result.pageErrorStatus).toBe(500);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Markdown cache failed");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("password=[REDACTED]");
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
  });

  it("preserves useful expected page errors without logging them as failures", async () => {
    mocks.loadPage.mockRejectedValueOnce(new ApiError(404, "Document not found."));

    const result = await loadInitialDocsClientData("/missing");

    expect(result.pageError).toBe("Document not found.");
    expect(result.pageErrorStatus).toBe(404);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("reports a docs root without any document as not found", async () => {
    const result = await loadInitialDocsClientData("/");

    expect(result.page).toBeNull();
    expect(result.pageErrorStatus).toBe(404);
    expect(mocks.loadPage).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("takes one admission permit for a docs root that loads its tree and first page", async () => {
    mocks.firstLeafPath.mockReturnValueOnce("/guide");

    const result = await loadInitialDocsClientData("/");

    expect(result.page).toMatchObject({ slug: "guide" });
    expect(mocks.loadTree).toHaveBeenCalledOnce();
    expect(mocks.loadPage).toHaveBeenCalledOnce();
    expect(mocks.admit).toHaveBeenCalledOnce();
  });

  it("reports a rejected admission as the page error", async () => {
    mocks.admit.mockRejectedValueOnce(new ApiError(429, "Too many requests."));

    const result = await loadInitialDocsClientData("/guide");

    expect(result).toMatchObject({ pageErrorStatus: 429, shell: { initialPath: "/guide" } });
    expect(result.page).toBeUndefined();
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });

  it("leaves the status unset when the page loads", async () => {
    const result = await loadInitialDocsClientData("/guide");

    expect(result.page).toMatchObject({ slug: "guide" });
    expect(result.pageErrorStatus).toBeUndefined();
  });

  it("sanitizes unexpected setup failures before returning initial data", async () => {
    const secret = "encrypted-store-secret";
    mocks.getStore.mockRejectedValueOnce(new Error(`Unable to decrypt token=${secret}`));

    const result = await loadInitialDocsClientData("/guide");

    expect(result).toMatchObject({ shell: { initialPath: "/guide" }, pageError: "The requested docs page could not be loaded.", pageErrorStatus: 500 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
  });

  it("does not copy a non-Error tree failure into initial data", async () => {
    const secret = "tree-header-secret";
    mocks.loadTree.mockRejectedValueOnce(`authorization=Bearer ${secret}`);

    const result = await loadInitialDocsClientData("/");

    expect(result.pageErrorStatus).toBe(500);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("authorization=[REDACTED]");
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
  });
});

describe("docs route data", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.nextHeaders.mockResolvedValue(new Headers());
    mocks.resolveRuntimeConfig.mockReturnValue({ branch: "main", docsPath: "docs", owner: "owner", repo: "repo", token: "token" });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("maps the optional catch-all slug to the requested docs path", () => {
    expect(docsRequestPath(undefined)).toBe("/");
    expect(docsRequestPath([])).toBe("/");
    expect(docsRequestPath(["de", "guide", "setup"])).toBe("/de/guide/setup");
  });

  it("forwards the bare docs index to the configured start page before loading docs", async () => {
    mocks.getStore.mockResolvedValue({ ...store, settings: { ...store.settings, startPage: "/guide" } });

    await expect(loadDocsRouteData("/")).rejects.toMatchObject({ location: docsHrefForPagePath("/guide", DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE) });
    expect(mocks.loadTree).not.toHaveBeenCalled();
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });

  it("reports an unreadable store at the bare docs index as a server failure instead of redirecting", async () => {
    mocks.getStore.mockRejectedValue(new Error("store unavailable"));

    const result = await loadDocsRouteData("/");

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(result.pageErrorStatus).toBe(500);
  });

  it("loads document routes without consulting the start page", async () => {
    mocks.getStore.mockResolvedValue(store);
    mocks.loadPage.mockResolvedValue({ data: { description: "", headings: [], includeInPlaintextExport: true, path: "guide.md", slug: "guide", sourceHeadings: [], title: "Guide" }, language: { code: "default" } });

    const result = await loadDocsRouteData("/guide");

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(result.page).toMatchObject({ slug: "guide" });
  });
});
