import { beforeEach, describe, expect, it, vi } from "vitest";

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
const shell: InitialDocsClientData["shell"] = { initialLanguageCode: "en", initialPath: "/guide" };
const page = { slug: "guide" } as NonNullable<InitialDocsClientData["page"]>;

describe("docs route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the loaded article for the requested path", async () => {
    mocks.loadDocsRouteData.mockResolvedValue({ page, shell } satisfies InitialDocsClientData);

    const element = await DocsPage({ params: routeParams(["de", "guide"]) });

    expect(mocks.loadDocsRouteData).toHaveBeenCalledWith("/de/guide");
    expect(element.type).toBe(DocsArticle);
    expect(element.props.page).toBe(page);
  });

  it("loads the docs index for the bare route", async () => {
    mocks.loadDocsRouteData.mockResolvedValue({ page, shell } satisfies InitialDocsClientData);

    await DocsPage({ params: routeParams() });

    expect(mocks.loadDocsRouteData).toHaveBeenCalledWith("/");
  });

  it("interrupts a missing page with the not-found boundary", async () => {
    mocks.loadDocsRouteData.mockResolvedValue({ page: null, pageError: "missing", pageErrorStatus: 404, shell } satisfies InitialDocsClientData);

    // `notFound()` signals the 404 status through this documented digest.
    await expect(DocsPage({ params: routeParams(["missing"]) })).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it.each([400, 409, 429, 500])("interrupts a page failing with status %i with the error boundary", async (pageErrorStatus) => {
    mocks.loadDocsRouteData.mockResolvedValue({ page: null, pageError: "failed", pageErrorStatus, shell } satisfies InitialDocsClientData);

    const thrown: unknown = await DocsPage({ params: routeParams(["guide"]) }).catch((error: unknown) => error);

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
