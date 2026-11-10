import { getRewrittenUrl, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import nextConfig from "../../../../next.config";
import { DocsArticle } from "@/components/docs-article";
import { DocsPageErrorMessageProvider } from "@/components/docs-page-error";
import { DocsShell } from "@/components/docs-shell";
import type { InitialDocsClientData } from "@/lib/docs-initial-data";

const mocks = vi.hoisted(() => ({ loadDocsRouteData: vi.fn() }));

vi.mock("@/lib/docs-initial-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docs-initial-data")>()),
  loadDocsRouteData: mocks.loadDocsRouteData,
}));

import DocsLayout from "./layout";
import DocsPage from "./page";

const routeParams = (slug?: string[]): Promise<{ slug?: string[] }> => Promise.resolve(slug ? { slug } : {});
const pageProps = (slug?: string[], searchParams: Record<string, string | string[]> = {}) => ({ params: routeParams(slug), searchParams: Promise.resolve(searchParams) });
const shell: InitialDocsClientData["shell"] = { initialLanguageCode: "en", initialPath: "/guide" };
const page = { slug: "guide" } as NonNullable<InitialDocsClientData["page"]>;

describe("docs route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the loaded article for the requested path", async () => {
    mocks.loadDocsRouteData.mockResolvedValue({ page, shell } satisfies InitialDocsClientData);

    const element = await DocsPage(pageProps(["de", "guide"]));

    expect(mocks.loadDocsRouteData).toHaveBeenCalledWith("/de/guide");
    expect(element.type).toBe(DocsArticle);
    expect(element.props.page).toBe(page);
  });

  it("loads the docs index for the bare route", async () => {
    mocks.loadDocsRouteData.mockResolvedValue({ page, shell } satisfies InitialDocsClientData);

    await DocsPage(pageProps());

    expect(mocks.loadDocsRouteData).toHaveBeenCalledWith("/");
  });

  it("serves both raw query forms as raw markdown", async () => {
    const rewrittenUrl = async (url: string) => getRewrittenUrl(await unstable_getResponseFromNextConfig({ nextConfig, url }));

    expect(await rewrittenUrl("https://docs.example.com/docs/de/guide?raw=1")).toBe("https://docs.example.com/api/docs/raw/de/guide?raw=1");
    // Rewrite conditions never match an empty query value, so the bare form reaches the page.
    expect(await rewrittenUrl("https://docs.example.com/docs/de/guide?raw")).toBeNull();
    await expect(DocsPage(pageProps(["de", "guide"], { raw: "" }))).rejects.toMatchObject({ digest: "NEXT_REDIRECT;replace;/docs/de/guide?raw=1;307;" });
  });

  it("forwards a bare raw request to its raw=1 URL without loading the page", async () => {
    // `redirect()` signals the 307 and its location through this digest.
    await expect(DocsPage(pageProps(["de", "guide notes"], { raw: "", language: "de", tag: ["a", "b"] }))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/docs/de/guide%20notes?raw=1&language=de&tag=a&tag=b;307;",
    });
    expect(mocks.loadDocsRouteData).not.toHaveBeenCalled();
  });

  it("interrupts a missing page with the not-found boundary", async () => {
    mocks.loadDocsRouteData.mockResolvedValue({ page: null, pageError: "missing", pageErrorStatus: 404, shell } satisfies InitialDocsClientData);

    // `notFound()` signals the 404 status through this documented digest.
    await expect(DocsPage(pageProps(["missing"]))).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it.each([400, 409, 429, 500])("interrupts a page failing with status %i with the error boundary", async (pageErrorStatus) => {
    mocks.loadDocsRouteData.mockResolvedValue({ page: null, pageError: "failed", pageErrorStatus, shell } satisfies InitialDocsClientData);

    const thrown: unknown = await DocsPage(pageProps(["guide"])).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { digest?: unknown }).digest).toBeUndefined();
  });

  it("renders the docs shell around the page and hands it the public page error", async () => {
    const pageError = `public-${Date.now()}`;
    mocks.loadDocsRouteData.mockResolvedValue({ page: null, pageError, pageErrorStatus: 404, shell } satisfies InitialDocsClientData);
    const children = <span />;

    const element = await DocsLayout({ children, params: routeParams(["missing"]) });
    const provider = element.props.children;

    expect(mocks.loadDocsRouteData).toHaveBeenCalledWith("/missing");
    expect(element.type).toBe(DocsShell);
    expect(element.props).toMatchObject(shell);
    expect(provider.type).toBe(DocsPageErrorMessageProvider);
    expect(provider.props.message).toBe(pageError);
    expect(provider.props.children).toBe(children);
  });

  it("provides no page error once the page loaded", async () => {
    mocks.loadDocsRouteData.mockResolvedValue({ page, shell } satisfies InitialDocsClientData);

    const element = await DocsLayout({ children: null, params: routeParams(["guide"]) });

    expect(element.props.children.props.message).toBeUndefined();
  });
});
