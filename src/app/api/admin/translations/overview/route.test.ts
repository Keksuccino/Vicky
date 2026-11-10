import { NextRequest, NextResponse } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  loadPageLocalizationOverview: vi.fn(),
  requireAdminRequest: vi.fn(),
}));

vi.mock("@/lib/active-auth", () => ({ requireAdminRequest: mocks.requireAdminRequest }));
vi.mock("@/lib/page-localization-read", () => ({ loadPageLocalizationOverview: mocks.loadPageLocalizationOverview }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { GET } from "./route";

const LANGUAGES = [
  { name: "English (US)", code: "en-US", icon: "us", enabled: true },
  { name: "German", code: "de", icon: "de", enabled: true },
];

const overviewRequest = (): NextRequest => new NextRequest("http://localhost/api/admin/translations/overview");

describe("admin translation overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminRequest.mockResolvedValue(null);
    mocks.getStore.mockResolvedValue({
      settings: {
        autoTranslate: { languages: LANGUAGES, localizationPath: "translations" },
        docsCacheTtlMs: 60_000,
        github: { owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: "" },
      },
    });
    mocks.loadPageLocalizationOverview.mockResolvedValue([{ languageCode: "de", currentPages: 1, loading: { downloaded: 1, total: 3 } }]);
  });

  it("computes the statuses for the saved languages and localization directory", async () => {
    const response = await GET(overviewRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ localizationPath: "translations", statuses: [{ languageCode: "de", loading: { downloaded: 1, total: 3 } }] });
    expect(mocks.loadPageLocalizationOverview).toHaveBeenCalledWith(expect.objectContaining({ languages: [expect.objectContaining({ code: "en-US" }), expect.objectContaining({ code: "de" })], localizationPath: "translations" }));
  });

  it("checks the admin session before reading anything", async () => {
    mocks.requireAdminRequest.mockResolvedValueOnce(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

    const response = await GET(overviewRequest());

    expect(response.status).toBe(401);
    expect(mocks.getStore).not.toHaveBeenCalled();
    expect(mocks.loadPageLocalizationOverview).not.toHaveBeenCalled();
  });
});
