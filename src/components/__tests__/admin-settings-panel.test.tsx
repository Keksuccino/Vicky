// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSettings, DomainSslRuntimeStatus } from "@/components/types";

import { AdminSettingsPanel } from "../admin-settings-panel";

const replaceMock = vi.fn();
const routerMock = {
  replace: replaceMock,
};
const setThemeSettingsMock = vi.fn();
const createAdminModeratorMock = vi.fn();
const deleteAdminModeratorMock = vi.fn();
const fetchAdminDomainSslStatusMock = vi.fn();
const fetchAdminModeratorsMock = vi.fn();
const fetchAdminSettingsMock = vi.fn();
const fetchAdminVisitorStatsMock = vi.fn();
const getCurrentUserMock = vi.fn();
const logoutMock = vi.fn();
const refreshAdminDocsCacheMock = vi.fn();
const saveAdminSettingsMock = vi.fn();
const testAdminConnectionMock = vi.fn();
const updateAdminModeratorMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({
    setThemeSettings: setThemeSettingsMock,
  }),
}));

vi.mock("@/components/api", () => ({
  createAdminModerator: (...args: unknown[]) => createAdminModeratorMock(...args),
  deleteAdminModerator: (...args: unknown[]) => deleteAdminModeratorMock(...args),
  fetchAdminDomainSslStatus: (...args: unknown[]) => fetchAdminDomainSslStatusMock(...args),
  fetchAdminModerators: (...args: unknown[]) => fetchAdminModeratorsMock(...args),
  fetchAdminSettings: (...args: unknown[]) => fetchAdminSettingsMock(...args),
  fetchAdminVisitorStats: (...args: unknown[]) => fetchAdminVisitorStatsMock(...args),
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : "Something went wrong. Please try again."),
  getCurrentUser: (...args: unknown[]) => getCurrentUserMock(...args),
  logout: (...args: unknown[]) => logoutMock(...args),
  refreshAdminDocsCache: (...args: unknown[]) => refreshAdminDocsCacheMock(...args),
  saveAdminSettings: (...args: unknown[]) => saveAdminSettingsMock(...args),
  testAdminConnection: (...args: unknown[]) => testAdminConnectionMock(...args),
  updateAdminModerator: (...args: unknown[]) => updateAdminModeratorMock(...args),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    reject,
    resolve,
  };
}

const INITIAL_SETTINGS: AdminSettings = {
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
  tokenConfigured: false,
  aiChatEnabled: false,
  aiChatAssistantName: "Vicky",
  aiChatAvatarUrl: "",
  aiChatHeaderSubtitle: "An actually useful AI chat assistant.",
  aiChatWelcomeMessage: "Hi, I'm {{assistant_name}}! 🌸 Ask me anything about these docs and I'll try to help you as best as possible! 😤",
  aiChatSystemPrompt: "System prompt with {{docs_content}}",
  openRouterModel: "openai/gpt-5.1-codex-mini",
  openRouterApiKey: "",
  openRouterApiKeyConfigured: false,
  autoTranslateEnabled: false,
  autoTranslateOpenRouterModel: "openai/gpt-5.4-mini",
  autoTranslateLanguages: [
    { name: "English (US)", code: "en-US" },
    { name: "German", code: "de" },
  ],
  themeLightAccent: "#006ecf",
  themeLightSurfaceAccent: "#7db8f0",
  themeDarkAccent: "#15A6E5",
  themeDarkSurfaceAccent: "#657276",
  themeCustomCss: "",
};

const SSL_STATUS: DomainSslRuntimeStatus = {
  source: "best-effort",
  configured: false,
  customDomain: "",
  letsEncryptEmail: "",
  certificateState: "missing",
  certificatePresent: false,
  certificateValidForDomain: null,
  certificateExpiresAt: null,
  checkedAt: "2026-03-10T12:00:00.000Z",
  message: "SSL runtime status is unavailable.",
};

const VISITOR_STATS = {
  updatedAt: "2026-03-10T12:00:00.000Z",
  scopes: {
    allTime: {
      totalVisits: 0,
      totalVisitors: 0,
      currentPeriodKey: "all-time",
      currentPeriodLabel: "All time",
      periods: [{ key: "all-time", label: "All time", visits: 0, visitors: 0, current: true }],
      pages: [],
    },
    daily: {
      totalVisits: 0,
      totalVisitors: 0,
      currentPeriodKey: "2026-03-10",
      currentPeriodLabel: "Mar 10",
      periods: [{ key: "2026-03-10", label: "Mar 10", visits: 0, visitors: 0, current: true }],
      pages: [],
    },
    weekly: {
      totalVisits: 0,
      totalVisitors: 0,
      currentPeriodKey: "2026-W11",
      currentPeriodLabel: "Week 11, 2026",
      periods: [{ key: "2026-W11", label: "Week 11, 2026", visits: 0, visitors: 0, current: true }],
      pages: [],
    },
    monthly: {
      totalVisits: 0,
      totalVisitors: 0,
      currentPeriodKey: "2026-03",
      currentPeriodLabel: "Mar 2026",
      periods: [{ key: "2026-03", label: "Mar 2026", visits: 0, visitors: 0, current: true }],
      pages: [],
    },
    yearly: {
      totalVisits: 0,
      totalVisitors: 0,
      currentPeriodKey: "2026",
      currentPeriodLabel: "2026",
      periods: [{ key: "2026", label: "2026", visits: 0, visitors: 0, current: true }],
      pages: [],
    },
  },
};

describe("AdminSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentUserMock.mockResolvedValue({ role: "admin", username: "admin" });
    fetchAdminSettingsMock.mockResolvedValue(INITIAL_SETTINGS);
    fetchAdminModeratorsMock.mockResolvedValue([]);
    fetchAdminDomainSslStatusMock.mockResolvedValue(SSL_STATUS);
    fetchAdminVisitorStatsMock.mockResolvedValue(VISITOR_STATS);
    createAdminModeratorMock.mockResolvedValue({
      id: "mod-1",
      username: "docs-editor",
      createdAt: "2026-03-10T12:00:00.000Z",
      updatedAt: "2026-03-10T12:00:00.000Z",
    });
    updateAdminModeratorMock.mockResolvedValue({
      id: "mod-1",
      username: "docs-editor",
      createdAt: "2026-03-10T12:00:00.000Z",
      updatedAt: "2026-03-10T12:00:00.000Z",
    });
    deleteAdminModeratorMock.mockResolvedValue(undefined);
    logoutMock.mockResolvedValue(undefined);
    refreshAdminDocsCacheMock.mockResolvedValue({
      pageCount: 1,
      fetchedAt: "2026-03-10T12:00:00.000Z",
      expiresAt: "2026-03-10T13:00:00.000Z",
    });
    testAdminConnectionMock.mockResolvedValue("ok");
  });

  it("keeps the newest typed value when an older autosave response resolves later", async () => {
    const firstSave = createDeferred<AdminSettings>();
    const secondSave = createDeferred<AdminSettings>();

    saveAdminSettingsMock
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);

    render(<AdminSettingsPanel />);

    const siteTitleInput = (await screen.findByRole("textbox", { name: /^Site title\b/ })) as HTMLInputElement;

    fireEvent.change(siteTitleInput, {
      target: { value: "Vicky Docs 1" },
    });

    await waitFor(() => {
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(siteTitleInput, {
      target: { value: "Vicky Docs 12" },
    });

    expect(siteTitleInput.value).toBe("Vicky Docs 12");

    await act(async () => {
      firstSave.resolve({
        ...INITIAL_SETTINGS,
        siteTitle: "Vicky Docs 1",
      });
      await firstSave.promise;
    });

    await waitFor(() => {
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(2);
    });

    expect(siteTitleInput.value).toBe("Vicky Docs 12");
    expect((saveAdminSettingsMock.mock.calls[1] ?? [])[0]?.siteTitle).toBe("Vicky Docs 12");

    await act(async () => {
      secondSave.resolve({
        ...INITIAL_SETTINGS,
        siteTitle: "Vicky Docs 12",
      });
      await secondSave.promise;
    });

    await waitFor(() => {
      expect(siteTitleInput.value).toBe("Vicky Docs 12");
    });
  });
});
