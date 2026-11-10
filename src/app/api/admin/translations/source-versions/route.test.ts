import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  requireAdminRequest: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
  setCacheTtl: vi.fn(),
  startJob: vi.fn(),
}));

vi.mock("@/lib/active-auth", () => ({ requireAdminRequest: mocks.requireAdminRequest }));
vi.mock("@/lib/cache", () => ({ setDocsCacheTtlMs: mocks.setCacheTtl }));
vi.mock("@/lib/github", () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig }));
vi.mock("@/lib/page-localization-jobs", () => ({ startSourceVersionRecordingJob: mocks.startJob }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { POST } from "./route";

const recordRequest = (body: unknown): NextRequest =>
  new NextRequest("http://localhost/api/admin/translations/source-versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/admin/translations/source-versions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStore.mockResolvedValue({
      settings: {
        autoTranslate: { languages: [{ name: "German", code: "de", icon: "de", enabled: true }], localizationPath: "localizations" },
        docsCacheTtlMs: 60_000,
        github: {},
      },
    });
    mocks.requireAdminRequest.mockResolvedValue(null);
    mocks.resolveRuntimeConfig.mockReturnValue({ branch: "main", docsPath: "docs", owner: "owner", repo: "repo", token: "token" });
    mocks.startJob.mockReturnValue({ id: "job-1", status: "running" });
  });

  it("starts the job with the saved localization settings and the confirmed number of files", async () => {
    const response = await POST(recordRequest({ expectedFiles: 1012 }));

    expect(response.status).toBe(202);
    expect(mocks.startJob).toHaveBeenCalledWith(expect.objectContaining({ localizationPath: "localizations", maxFiles: 1012, languages: expect.arrayContaining([expect.objectContaining({ code: "de" })]) }));
  });

  it("never starts without a confirmed number of files", async () => {
    for (const body of [{}, { expectedFiles: 0 }, { expectedFiles: 1.5 }, { expectedFiles: 3, languages: [] }]) {
      expect((await POST(recordRequest(body))).status).toBe(400);
    }
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it("requires an admin session", async () => {
    mocks.requireAdminRequest.mockResolvedValueOnce(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));

    expect((await POST(recordRequest({ expectedFiles: 3 }))).status).toBe(401);
    expect(mocks.startJob).not.toHaveBeenCalled();
  });
});
