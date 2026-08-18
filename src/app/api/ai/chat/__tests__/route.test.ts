import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  decryptSecret: vi.fn(),
  getPlaintextDocsExport: vi.fn(),
  getStore: vi.fn(),
  requestCompletion: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
  setCacheTtl: vi.fn(),
}));

vi.mock("@/lib/ai-chat-rate-limit", () => ({ consumeAiChatRateLimit: mocks.consumeRateLimit }));
vi.mock("@/lib/cache", () => ({ setDocsCacheTtlMs: mocks.setCacheTtl }));
vi.mock("@/lib/docs-plaintext", () => ({ getPlaintextDocsExport: mocks.getPlaintextDocsExport }));
vi.mock("@/lib/encryption", () => ({ decryptSecret: mocks.decryptSecret }));
vi.mock("@/lib/github", () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig }));
vi.mock("@/lib/openrouter", () => ({ requestOpenRouterChatCompletion: mocks.requestCompletion }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { POST } from "@/app/api/ai/chat/route";

describe("POST /api/ai/chat origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeRateLimit.mockReturnValue({ blocked: false, retryAfterSeconds: 0 });
    mocks.decryptSecret.mockReturnValue("openrouter-secret");
    mocks.getPlaintextDocsExport.mockResolvedValue("# Docs");
    mocks.getStore.mockResolvedValue({
      settings: {
        aiChat: { assistantName: "Vicky", enabled: true, openRouterModel: "openai/test", systemPrompt: "Help with docs." },
        docsCacheTtlMs: 60_000,
        domain: { customDomain: "canonical.example.com" },
        github: {},
        openRouter: { apiKeyEncrypted: "encrypted" },
        siteTitle: "Vicky Docs",
      },
    });
    mocks.requestCompletion.mockResolvedValue("Answer");
    mocks.resolveRuntimeConfig.mockReturnValue({ branch: "main", docsPath: "docs", owner: "owner", repo: "repo", token: "token" });
  });

  it("uses the canonical origin for plaintext links and OpenRouter attribution", async () => {
    const request = new NextRequest("https://internal.example/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json", host: "internal.example", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" },
      body: JSON.stringify({ messages: [{ role: "user", text: "Where do I start?" }] }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.getPlaintextDocsExport).toHaveBeenCalledWith(expect.any(Object), "https://canonical.example.com");
    expect(mocks.requestCompletion).toHaveBeenCalledWith(expect.objectContaining({ origin: "https://canonical.example.com", siteTitle: "Vicky Docs" }));
  });
});
