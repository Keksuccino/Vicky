import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildDocTree: vi.fn(),
  firstLeafPath: vi.fn(),
  getStore: vi.fn(),
  loadPage: vi.fn(),
  loadTree: vi.fn(),
  nextHeaders: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
  setCacheTtl: vi.fn(),
  toAbsoluteDocPath: vi.fn((value: string) => value.startsWith("/") ? value : `/${value}`),
}));

vi.mock("next/headers", () => ({ headers: mocks.nextHeaders }));
vi.mock("@/components/api", () => ({ buildDocTree: mocks.buildDocTree, firstLeafPath: mocks.firstLeafPath, toAbsoluteDocPath: mocks.toAbsoluteDocPath }));
vi.mock("@/lib/cache", () => ({ setDocsCacheTtlMs: mocks.setCacheTtl }));
vi.mock("@/lib/docs-server-data", () => ({ loadDocsTreeForLanguage: mocks.loadTree, loadRenderedDocsPageForLanguage: mocks.loadPage }));
vi.mock("@/lib/github", () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { loadInitialDocsClientData } from "@/lib/docs-initial-data";
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

    expect(result.pageError).toBe("The requested docs page could not be loaded.");
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
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("sanitizes unexpected setup failures before returning initial data", async () => {
    const secret = "encrypted-store-secret";
    mocks.getStore.mockRejectedValueOnce(new Error(`Unable to decrypt token=${secret}`));

    const result = await loadInitialDocsClientData("/guide");

    expect(result).toMatchObject({ initialPath: "/guide", pageError: "The requested docs page could not be loaded." });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
  });

  it("does not copy a non-Error tree failure into initial data", async () => {
    const secret = "tree-header-secret";
    mocks.loadTree.mockRejectedValueOnce(`authorization=Bearer ${secret}`);

    const result = await loadInitialDocsClientData("/");

    expect(result.pageError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("authorization=[REDACTED]");
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
  });
});
