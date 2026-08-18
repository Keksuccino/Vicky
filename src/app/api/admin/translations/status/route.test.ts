import { NextRequest, NextResponse } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  listMarkdownDocsTreePagesWithTitles: vi.fn(),
  loadGitHubLocalizationStatusIndex: vi.fn(),
  requireAdminRequest: vi.fn(),
  translatePageLocalizations: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdminRequest: mocks.requireAdminRequest }));
vi.mock("@/lib/github", () => ({ listMarkdownDocsTreePagesWithTitles: mocks.listMarkdownDocsTreePagesWithTitles, loadGitHubLocalizationStatusIndex: mocks.loadGitHubLocalizationStatusIndex }));
vi.mock("@/lib/page-localization", () => ({ translatePageLocalizations: mocks.translatePageLocalizations }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { POST } from "./route";

const statusRequest = (body: unknown): NextRequest => new NextRequest("http://localhost/api/admin/translations/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("admin translation status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("vicky.pageLocalization.jobState")];
    mocks.requireAdminRequest.mockResolvedValue(null);
  });

  it("serves repeated polls entirely from bounded local job state", async () => {
    for (let index = 0; index < 10; index += 1) {
      const response = await POST(statusRequest({ languages: [{ code: "de" }], localizationPath: "localizations" }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ job: null, jobState: "none", statuses: [] });
    }

    expect(mocks.listMarkdownDocsTreePagesWithTitles).not.toHaveBeenCalled();
    expect(mocks.loadGitHubLocalizationStatusIndex).not.toHaveBeenCalled();
    expect(mocks.translatePageLocalizations).not.toHaveBeenCalled();
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("reports a tracked job as unknown after its in-process state is unavailable", async () => {
    const response = await POST(statusRequest({ jobId: "translation-before-restart" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({ job: null, jobState: "unknown", statuses: [] });
    expect(mocks.listMarkdownDocsTreePagesWithTitles).not.toHaveBeenCalled();
    expect(mocks.loadGitHubLocalizationStatusIndex).not.toHaveBeenCalled();
  });

  it("preserves the admin guard before reading local job state", async () => {
    mocks.requireAdminRequest.mockResolvedValueOnce(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

    const response = await POST(statusRequest({}));

    expect(response.status).toBe(401);
    expect(mocks.listMarkdownDocsTreePagesWithTitles).not.toHaveBeenCalled();
  });
});
