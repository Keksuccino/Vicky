import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  decryptSecret: vi.fn(),
  getStore: vi.fn(),
  requireAdminRequest: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
  setCacheTtl: vi.fn(),
  startJob: vi.fn(),
}));

vi.mock("@/lib/active-auth", () => ({ requireAdminRequest: mocks.requireAdminRequest }));
vi.mock("@/lib/cache", () => ({ setDocsCacheTtlMs: mocks.setCacheTtl }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: mocks.decryptSecret }));
vi.mock("@/lib/github", () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig }));
vi.mock("@/lib/page-localization-jobs", () => ({ startPageLocalizationJob: mocks.startJob }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { POST } from "@/app/api/admin/translations/request/route";

describe("POST /api/admin/translations/request origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decryptSecret.mockReturnValue("openrouter-secret");
    mocks.getStore.mockResolvedValue({
      settings: {
        autoTranslate: { languages: [], localizationPath: "localizations", openRouterModel: "openai/test", requestTimeoutMs: 60_000 },
        docsCacheTtlMs: 60_000,
        domain: { customDomain: "canonical.example.com" },
        github: {},
        openRouter: { apiKeyEncrypted: "encrypted" },
        siteTitle: "Vicky Docs",
      },
    });
    mocks.requireAdminRequest.mockResolvedValue(null);
    mocks.resolveRuntimeConfig.mockReturnValue({ branch: "main", docsPath: "docs", owner: "owner", repo: "repo", token: "token" });
    mocks.startJob.mockReturnValue({ id: "job-1", status: "running" });
  });

  it("passes the canonical origin into the background localization job", async () => {
    const request = new NextRequest("https://internal.example/api/admin/translations/request", {
      method: "POST",
      headers: { "content-type": "application/json", host: "internal.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
      body: JSON.stringify({ language: { code: "de", icon: "de", name: "German" } }),
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(mocks.startJob).toHaveBeenCalledWith(expect.objectContaining({ origin: "https://canonical.example.com", siteTitle: "Vicky Docs" }));
  });
});
