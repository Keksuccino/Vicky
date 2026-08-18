import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAdminDomainSslStatus, fetchAdminLanguageTranslationStatus, saveAdminSettings } from "@/components/api";
import type { AdminSettings } from "@/components/types";

const createSettings = (overrides: Partial<AdminSettings> = {}): AdminSettings => ({
  siteTitle: "Vicky Docs",
  siteDescription: "Documentation knowledge base",
  footerText: "Footer",
  startPage: "/home",
  siteTitleGradientFrom: "",
  siteTitleGradientTo: "",
  docsIconPng16Url: "",
  docsIconPng32Url: "",
  docsIconPng180Url: "",
  docsRefreshIntervalMinutes: 60,
  customDomain: "",
  letsEncryptEmail: "",
  githubOwner: "Keksuccino",
  githubRepo: "Vicky",
  githubBranch: "main",
  githubDocsPath: "docs",
  githubToken: "",
  tokenConfigured: true,
  aiChatEnabled: false,
  aiChatAssistantName: "Vicky",
  aiChatAvatarUrl: "",
  aiChatHeaderSubtitle: "Docs helper",
  aiChatWelcomeMessage: "Ask me anything about these docs.",
  aiChatSystemPrompt: "System prompt with {{docs_content}}",
  openRouterModel: "openai/gpt-5.4-mini",
  openRouterApiKey: "",
  openRouterApiKeyConfigured: true,
  autoTranslateEnabled: false,
  autoTranslateOpenRouterModel: "openai/gpt-5.4-mini",
  autoTranslateRequestTimeoutSeconds: 300,
  autoTranslateLanguages: [{ name: "English (US)", code: "en-US", icon: "us", enabled: true }],
  autoTranslateLocalizationPath: "localizations",
  themeLightAccent: "#2563eb",
  themeLightSurfaceAccent: "#f8fafc",
  themeDarkAccent: "#60a5fa",
  themeDarkSurfaceAccent: "#0f172a",
  themeCustomCss: "",
  ...overrides,
});

const jsonResponse = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });

describe("admin API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("omits empty secret fields from settings saves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings: createSettings() }));
    vi.stubGlobal("fetch", fetchMock);

    await saveAdminSettings(createSettings());

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      github: { token?: string };
      openRouter: { apiKey?: string };
    };

    expect(body.github.token).toBeUndefined();
    expect(body.openRouter.apiKey).toBeUndefined();
  });

  it("sends newly entered secret fields in settings saves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ settings: createSettings() }));
    vi.stubGlobal("fetch", fetchMock);

    await saveAdminSettings(createSettings({ githubToken: "ghp_new", openRouterApiKey: "or_new" }));

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      github: { token?: string };
      openRouter: { apiKey?: string };
    };

    expect(body.github.token).toBe("ghp_new");
    expect(body.openRouter.apiKey).toBe("or_new");
  });

  it("scopes translation status polls to the tracked local job ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ statuses: [], job: null, jobState: "unknown", updatedAt: "2026-08-18T00:00:00.000Z" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAdminLanguageTranslationStatus("translation-123");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;

    expect(body).toEqual({ jobId: "translation-123" });
    expect(result.jobState).toBe("unknown");
  });

  it("normalizes authenticated fail-closed domain status fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: {
        source: "runtime",
        configured: true,
        customDomain: "docs.example.com",
        letsEncryptEmail: "admin@example.com",
        certificateState: "expired",
        certificatePresent: true,
        certificateValidForDomain: true,
        certificateExpiresAt: "2026-08-17T00:00:00.000Z",
        httpsAvailable: false,
        customDomainHttpPolicy: "maintenance",
        checkedAt: "2026-08-18T00:00:00.000Z",
        message: "HTTPS is unavailable.",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAdminDomainSslStatus()).resolves.toMatchObject({
      source: "runtime",
      certificateState: "expired",
      httpsAvailable: false,
      customDomainHttpPolicy: "maintenance",
    });
  });
});
