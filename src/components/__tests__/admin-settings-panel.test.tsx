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
const clearAdminMarkdownCacheMock = vi.fn();
const createAdminModeratorMock = vi.fn();
const deleteAdminModeratorMock = vi.fn();
const fetchAdminDomainSslStatusMock = vi.fn();
const fetchAdminLanguageTranslationStatusMock = vi.fn();
const fetchAdminMarkdownCacheStatusMock = vi.fn();
const fetchAdminModeratorsMock = vi.fn();
const fetchAdminPerformanceStatsMock = vi.fn();
const fetchAdminSettingsMock = vi.fn();
const fetchAdminVisitorStatsMock = vi.fn();
const getCurrentUserMock = vi.fn();
const logoutMock = vi.fn();
const refreshAdminDocsCacheMock = vi.fn();
const requestAdminLanguageTranslationsMock = vi.fn();
const requestAdminSourceVersionRecordingMock = vi.fn();
const saveAdminSettingsMock = vi.fn();
const testAdminConnectionMock = vi.fn();
const updateAdminModeratorMock = vi.fn();
const warmAdminMarkdownCacheMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({
    setThemeSettings: setThemeSettingsMock,
  }),
}));

vi.mock("@/components/api", () => ({
  clearAdminMarkdownCache: (...args: unknown[]) => clearAdminMarkdownCacheMock(...args),
  createAdminModerator: (...args: unknown[]) => createAdminModeratorMock(...args),
  deleteAdminModerator: (...args: unknown[]) => deleteAdminModeratorMock(...args),
  fetchAdminDomainSslStatus: (...args: unknown[]) => fetchAdminDomainSslStatusMock(...args),
  fetchAdminLanguageTranslationStatus: (...args: unknown[]) => fetchAdminLanguageTranslationStatusMock(...args),
  fetchAdminMarkdownCacheStatus: (...args: unknown[]) => fetchAdminMarkdownCacheStatusMock(...args),
  fetchAdminModerators: (...args: unknown[]) => fetchAdminModeratorsMock(...args),
  fetchAdminPerformanceStats: (...args: unknown[]) => fetchAdminPerformanceStatsMock(...args),
  fetchAdminSettings: (...args: unknown[]) => fetchAdminSettingsMock(...args),
  fetchAdminVisitorStats: (...args: unknown[]) => fetchAdminVisitorStatsMock(...args),
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : "Something went wrong. Please try again."),
  getCurrentUser: (...args: unknown[]) => getCurrentUserMock(...args),
  logout: (...args: unknown[]) => logoutMock(...args),
  refreshAdminDocsCache: (...args: unknown[]) => refreshAdminDocsCacheMock(...args),
  requestAdminLanguageTranslations: (...args: unknown[]) => requestAdminLanguageTranslationsMock(...args),
  requestAdminSourceVersionRecording: (...args: unknown[]) => requestAdminSourceVersionRecordingMock(...args),
  saveAdminSettings: (...args: unknown[]) => saveAdminSettingsMock(...args),
  testAdminConnection: (...args: unknown[]) => testAdminConnectionMock(...args),
  updateAdminModerator: (...args: unknown[]) => updateAdminModeratorMock(...args),
  warmAdminMarkdownCache: (...args: unknown[]) => warmAdminMarkdownCacheMock(...args),
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
  openRouterModel: "openai/gpt-5.4-mini",
  openRouterApiKey: "",
  openRouterApiKeyConfigured: false,
  autoTranslateEnabled: false,
  autoTranslateOpenRouterModel: "openai/gpt-5.4-mini",
  autoTranslateRequestTimeoutSeconds: 300,
  autoTranslateLocalizationPath: "localizations",
  autoTranslateLanguages: [
    { name: "English (US)", code: "en-US", icon: "us", enabled: true },
    { name: "German", code: "de", icon: "de", enabled: true },
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
  httpsAvailable: false,
  customDomainHttpPolicy: "application",
  checkedAt: "2026-03-10T12:00:00.000Z",
  message: "SSL runtime status is unavailable.",
};

const VISITOR_STATS = {
  updatedAt: "2026-03-10T12:00:00.000Z",
  computedAt: "2026-03-10T12:00:00.000Z",
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

const IDLE_VISITOR_STATUS = { catchingUp: null, refreshing: false, error: null };

const PERFORMANCE_STATS = {
  updatedAt: "2026-03-10T12:00:00.000Z",
  memory: {
    totalBytes: 16 * 1024 ** 3,
    usedBytes: 4 * 1024 ** 3,
    freeBytes: 12 * 1024 ** 3,
    usagePercent: 25,
  },
  cpu: {
    usagePercent: 18,
    logicalCores: 8,
    sampleMs: 180,
  },
  drive: {
    path: "/wiki",
    totalBytes: 256 * 1024 ** 3,
    usedBytes: 128 * 1024 ** 3,
    freeBytes: 128 * 1024 ** 3,
    availableBytes: 128 * 1024 ** 3,
    usagePercent: 50,
  },
};

const MARKDOWN_CACHE_STATUS = {
  cacheDirectory: "/wiki/data/markdown-cache",
  cachedVariants: 1,
  currentSourceEntries: 1,
  currentSourceHtmlBytes: 1024,
  globalEntries: 3,
  globalHtmlBytes: 3072,
  globalStaleEntries: 2,
  lastMutation: null,
  otherSourceEntries: 2,
  processId: 1234,
  rendererVersion: "1",
  sourcePagesCached: 1,
  staleEntries: 0,
  totalHtmlBytes: 1024,
  totalPages: 1,
  totalVariants: 2,
  translatedVariants: 1,
  uncachedVariants: 1,
  updatedAt: "2026-03-10T12:00:00.000Z",
  pages: [
    {
      cachedVariants: 1,
      languages: [
        {
          cached: true,
          contentHash: "source",
          headingCount: 1,
          htmlBytes: 1024,
          languageCode: "en-US",
          languageName: "English (US)",
          savedAt: "2026-03-10T12:00:00.000Z",
          sourceLanguage: true,
        },
        {
          cached: false,
          contentHash: "translated",
          headingCount: 0,
          htmlBytes: 0,
          languageCode: "de",
          languageName: "German",
          savedAt: null,
          sourceLanguage: false,
        },
      ],
      path: "home.md",
      slug: "home",
      title: "Home",
      totalVariants: 2,
    },
  ],
};

describe("AdminSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentUserMock.mockResolvedValue({ role: "admin", username: "admin" });
    fetchAdminSettingsMock.mockResolvedValue(INITIAL_SETTINGS);
    fetchAdminModeratorsMock.mockResolvedValue([]);
    fetchAdminDomainSslStatusMock.mockResolvedValue(SSL_STATUS);
    fetchAdminLanguageTranslationStatusMock.mockResolvedValue({
      statuses: [],
      job: null,
      updatedAt: "2026-03-10T12:00:00.000Z",
    });
    fetchAdminMarkdownCacheStatusMock.mockResolvedValue(MARKDOWN_CACHE_STATUS);
    fetchAdminPerformanceStatsMock.mockResolvedValue(PERFORMANCE_STATS);
    fetchAdminVisitorStatsMock.mockResolvedValue({ stats: VISITOR_STATS, status: IDLE_VISITOR_STATUS });
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
    requestAdminLanguageTranslationsMock.mockResolvedValue({
      id: "translation-test",
      status: "running",
      phase: "translating",
      mode: "missing-and-outdated",
      createdAt: "2026-03-10T12:00:00.000Z",
      startedAt: "2026-03-10T12:00:00.000Z",
      finishedAt: null,
      languages: [{ name: "German", code: "de" }],
      localizationPath: "localizations",
      model: "openai/gpt-5.4-mini",
      result: {
        totalPages: 1,
        cachedPages: 0,
        requestedPages: 1,
        translatedPages: 0,
        uploadedPages: 0,
        translationFailedPages: 0,
        uploadFailedPages: 0,
        failedPages: 0,
        failures: [],
      },
      error: null,
      logs: [],
    });
    testAdminConnectionMock.mockResolvedValue("ok");
    clearAdminMarkdownCacheMock.mockResolvedValue({
      result: { clearedEntries: 1, scope: "all" },
      status: MARKDOWN_CACHE_STATUS,
    });
    warmAdminMarkdownCacheMock.mockResolvedValue({
      result: {
        cachedVariants: 1,
        failedVariants: 0,
        failures: [],
        renderedVariants: 1,
        skippedVariants: 1,
        totalPages: 1,
        totalVariants: 2,
      },
      status: { ...MARKDOWN_CACHE_STATUS, cachedVariants: 2, uncachedVariants: 0 },
    });
  });

  it("offers recording source versions only while unrecorded translations exist, and starts it after confirmation with the count", async () => {
    const finishedJob = {
      id: "translation-done",
      status: "completed",
      phase: "finished",
      mode: "outdated",
      createdAt: "2026-03-10T12:00:00.000Z",
      startedAt: "2026-03-10T12:00:00.000Z",
      finishedAt: "2026-03-10T12:01:00.000Z",
      languages: [{ name: "German", code: "de" }],
      localizationPath: "localizations",
      model: "openai/gpt-5.4-mini",
      result: { totalPages: 4, cachedPages: 4, requestedPages: 0, translatedPages: 0, uploadedPages: 0, translationFailedPages: 0, uploadFailedPages: 0, failedPages: 0, failures: [] },
      error: null,
      logs: [],
    };
    const germanStatus = { languageCode: "de", languageName: "German", cachedPages: 4, currentPages: 4, missingPages: 0, outdatedPages: 0, totalPages: 4, sourceLanguage: false };
    fetchAdminLanguageTranslationStatusMock.mockResolvedValue({ statuses: [{ ...germanStatus, unrecordedPages: 3 }], job: finishedJob, jobState: "current", updatedAt: "2026-03-10T12:00:00.000Z" });
    requestAdminSourceVersionRecordingMock.mockResolvedValue({ ...finishedJob, id: "source-versions", status: "running", phase: "checking", mode: "source-versions", finishedAt: null });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<AdminSettingsPanel />);
    const recordButton = await screen.findByRole("button", { name: "Record Source Versions" }, { timeout: 3_000 });

    fireEvent.click(recordButton);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(requestAdminSourceVersionRecordingMock).not.toHaveBeenCalled();

    fetchAdminLanguageTranslationStatusMock.mockResolvedValue({ statuses: [{ ...germanStatus, unrecordedPages: 0 }], job: { ...finishedJob, id: "source-versions", mode: "source-versions" }, jobState: "current", updatedAt: "2026-03-10T12:02:00.000Z" });
    fireEvent.click(recordButton);
    await waitFor(() => expect(requestAdminSourceVersionRecordingMock).toHaveBeenCalledWith(3));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Record Source Versions|Recording/ })).toBeNull());
    confirm.mockRestore();
  });

  it("shows analytics catch-up progress and never lets an older analytics response replace a newer one", async () => {
    const statsWithVisits = (totalVisits: number) => ({ ...VISITOR_STATS, scopes: { ...VISITOR_STATS.scopes, allTime: { ...VISITOR_STATS.scopes.allTime, totalVisits } } });
    const catchingUp = (processed: number) => ({ ...IDLE_VISITOR_STATUS, catchingUp: { processed, total: 100, etaSeconds: 90 } });
    const poll = createDeferred<unknown>();
    const manualRefresh = createDeferred<unknown>();
    fetchAdminVisitorStatsMock
      .mockResolvedValueOnce({ stats: statsWithVisits(100), status: catchingUp(25) })
      .mockImplementationOnce(() => poll.promise)
      .mockImplementationOnce(() => manualRefresh.promise);

    const { container } = render(<AdminSettingsPanel />);
    const card = (): Element | null => container.querySelector(".panel-card-visitors");
    const shownVisits = (): string | null | undefined => card()?.querySelector(".visitor-sparkline-card-visits .visitor-sparkline-meta strong")?.textContent;
    await waitFor(() => expect(card()?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25"), { timeout: 3_000 });
    expect(shownVisits()).toBe("100");

    // A background poll starts while catching up; the admin refreshes before it answers.
    await waitFor(() => expect(fetchAdminVisitorStatsMock).toHaveBeenCalledTimes(2), { timeout: 3_500 });
    fireEvent.click(card()!.querySelector(".visitor-refresh-button")!);
    expect(fetchAdminVisitorStatsMock).toHaveBeenLastCalledWith({ refresh: true });

    await act(async () => {
      manualRefresh.resolve({ stats: statsWithVisits(300), status: IDLE_VISITOR_STATUS });
      await manualRefresh.promise;
    });
    await act(async () => {
      poll.resolve({ stats: statsWithVisits(200), status: catchingUp(60) });
      await poll.promise;
    });

    expect(shownVisits()).toBe("300");
    expect(card()?.querySelector('[role="progressbar"]')).toBeNull();
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

  it("clears saved GitHub token input before later settings saves", async () => {
    saveAdminSettingsMock.mockResolvedValue({
      ...INITIAL_SETTINGS,
      tokenConfigured: true,
    });

    render(<AdminSettingsPanel />);

    const tokenInput = (await screen.findByLabelText(/^GitHub token\b/)) as HTMLInputElement;

    fireEvent.change(tokenInput, {
      target: { value: "ghp_saved" },
    });

    await waitFor(() => {
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
      expect(tokenInput.value).toBe("");
    });

    const siteTitleInput = screen.getByRole("textbox", { name: /^Site title\b/ }) as HTMLInputElement;
    fireEvent.change(siteTitleInput, {
      target: { value: "Vicky Docs without secret resend" },
    });

    await waitFor(() => {
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(2);
    });

    expect((saveAdminSettingsMock.mock.calls[1] ?? [])[0]?.githubToken).toBe("");
  });
});
