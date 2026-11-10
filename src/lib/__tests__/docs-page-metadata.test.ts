import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  loadDocsRouteData: vi.fn(),
  nextHeaders: vi.fn(),
  noStore: vi.fn(),
}));

vi.mock("next/cache", () => ({ unstable_noStore: mocks.noStore }));
vi.mock("next/headers", () => ({ headers: mocks.nextHeaders }));
vi.mock("@/lib/docs-initial-data", () => ({
  docsRequestPath: (slug: string[] | undefined) => (slug?.length ? `/${slug.join("/")}` : "/"),
  loadDocsRouteData: mocks.loadDocsRouteData,
}));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";

const originalTrustProxyOriginHeaders = process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS;

const createStore = (customDomain: string) => ({
  settings: {
    autoTranslate: { languages: [] },
    domain: { customDomain },
    github: {},
    siteDescription: "Site description",
    siteTitle: "Site title",
    startPage: "/home",
  },
});

describe("docs page metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS = "false";
    mocks.getStore.mockResolvedValue(createStore(""));
    mocks.nextHeaders.mockResolvedValue(new Headers({ host: "docs.example.com" }));
    mocks.loadDocsRouteData.mockResolvedValue({
      page: { description: "Page description", slug: "guide/getting-started", title: "Getting started" },
      shell: { initialLanguageCode: "en-US", initialPageLanguageCode: "en-US" },
    });
  });

  afterEach(() => {
    if (originalTrustProxyOriginHeaders === undefined) {
      delete process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS;
    } else {
      process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS = originalTrustProxyOriginHeaders;
    }
  });

  it("reads the page from the request's single route load instead of loading it again", async () => {
    const metadata = await generateDocsPageMetadata(["de", "guide", "getting-started"]);

    expect(mocks.loadDocsRouteData).toHaveBeenCalledOnce();
    expect(mocks.loadDocsRouteData).toHaveBeenCalledWith("/de/guide/getting-started");
    expect(metadata).toMatchObject({ title: "Getting started", description: "Page description" });
  });

  it("returns default metadata for a missing page and leaves the docs index to the layout", async () => {
    mocks.loadDocsRouteData.mockResolvedValueOnce({ page: null, pageErrorStatus: 404, shell: { initialLanguageCode: "en-US" } });

    await expect(generateDocsPageMetadata(["missing"])).resolves.toEqual({});
    await expect(generateDocsPageMetadata(undefined)).resolves.toEqual({});
    expect(mocks.loadDocsRouteData).toHaveBeenCalledOnce();
  });

  it("uses the canonical configured domain despite poisoned forwarding headers", async () => {
    mocks.getStore.mockResolvedValueOnce(createStore("Canonical.Example.com"));
    mocks.nextHeaders.mockResolvedValueOnce(new Headers({ host: "direct.example.com", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" }));

    const metadata = await generateDocsPageMetadata(["guide", "getting-started"]);

    expect(metadata.alternates?.canonical).toBe("https://canonical.example.com/docs/en-US/guide/getting-started");
    expect(metadata.openGraph?.url).toBe("https://canonical.example.com/docs/en-US/guide/getting-started");
  });

  it("uses a validated direct localhost authority when no canonical domain is configured", async () => {
    mocks.nextHeaders.mockResolvedValueOnce(new Headers({ host: "localhost:3000", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https" }));

    const metadata = await generateDocsPageMetadata(["guide", "getting-started"]);

    expect(metadata.alternates?.canonical).toBe("http://localhost:3000/docs/en-US/guide/getting-started");
    expect(metadata.openGraph?.url).toBe("http://localhost:3000/docs/en-US/guide/getting-started");
  });
});
