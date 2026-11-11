// @vitest-environment jsdom

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TYPING_SAVE_DELAY_MS } from "@/components/admin-settings/settings-auto-save";
import type { AdminSettings, DomainSslRuntimeStatus } from "@/components/types";

import { AdminSettingsPanel } from "../admin-settings-panel";

const replaceMock = vi.fn();
const routerMock = {
  replace: replaceMock,
};
const setThemeSettingsMock = vi.fn();
const clearAdminGitHubTokenMock = vi.fn();
const clearAdminMarkdownCacheMock = vi.fn();
const createAdminModeratorMock = vi.fn();
const deleteAdminModeratorMock = vi.fn();
const fetchAdminDomainSslStatusMock = vi.fn();
const fetchAdminLanguageTranslationOverviewMock = vi.fn();
const fetchAdminLanguageTranslationStatusMock = vi.fn();
const fetchAdminMarkdownCacheStatusMock = vi.fn();
const fetchAdminMarkdownCacheWarmJobMock = vi.fn();
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
const startAdminMarkdownCacheWarmJobMock = vi.fn();
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
  clearAdminGitHubToken: (...args: unknown[]) => clearAdminGitHubTokenMock(...args),
  clearAdminMarkdownCache: (...args: unknown[]) => clearAdminMarkdownCacheMock(...args),
  createAdminModerator: (...args: unknown[]) => createAdminModeratorMock(...args),
  deleteAdminModerator: (...args: unknown[]) => deleteAdminModeratorMock(...args),
  fetchAdminDomainSslStatus: (...args: unknown[]) => fetchAdminDomainSslStatusMock(...args),
  fetchAdminLanguageTranslationOverview: (...args: unknown[]) => fetchAdminLanguageTranslationOverviewMock(...args),
  fetchAdminLanguageTranslationStatus: (...args: unknown[]) => fetchAdminLanguageTranslationStatusMock(...args),
  fetchAdminMarkdownCacheStatus: (...args: unknown[]) => fetchAdminMarkdownCacheStatusMock(...args),
  fetchAdminMarkdownCacheWarmJob: (...args: unknown[]) => fetchAdminMarkdownCacheWarmJobMock(...args),
  fetchAdminModerators: (...args: unknown[]) => fetchAdminModeratorsMock(...args),
  fetchAdminPerformanceStats: (...args: unknown[]) => fetchAdminPerformanceStatsMock(...args),
  fetchAdminSettings: (...args: unknown[]) => fetchAdminSettingsMock(...args),
  fetchAdminVisitorStats: (...args: unknown[]) => fetchAdminVisitorStatsMock(...args),
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : "Something went wrong. Please try again."),
  getCurrentUser: (...args: unknown[]) => getCurrentUserMock(...args),
  MAX_DOCS_REFRESH_INTERVAL_MINUTES: 1_440,
  MIN_DOCS_REFRESH_INTERVAL_MINUTES: 1,
  logout: (...args: unknown[]) => logoutMock(...args),
  refreshAdminDocsCache: (...args: unknown[]) => refreshAdminDocsCacheMock(...args),
  requestAdminLanguageTranslations: (...args: unknown[]) => requestAdminLanguageTranslationsMock(...args),
  requestAdminSourceVersionRecording: (...args: unknown[]) => requestAdminSourceVersionRecordingMock(...args),
  saveAdminSettings: (...args: unknown[]) => saveAdminSettingsMock(...args),
  startAdminMarkdownCacheWarmJob: (...args: unknown[]) => startAdminMarkdownCacheWarmJobMock(...args),
  testAdminConnection: (...args: unknown[]) => testAdminConnectionMock(...args),
  updateAdminModerator: (...args: unknown[]) => updateAdminModeratorMock(...args),
}));

/** Waits until `selector` matches inside `container` and returns the element. */
const findElement = async <T extends Element>(container: HTMLElement, selector: string): Promise<T> => {
  let element: T | null = null;
  await waitFor(() => {
    element = container.querySelector<T>(selector);
    expect(element).not.toBeNull();
  }, { timeout: 3_000 });
  return element as unknown as T;
};

/** Lets pending promises and React updates settle. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

/** Waits as long as typing has to pause before it is saved. */
const pauseTyping = () => act(() => new Promise((resolve) => setTimeout(resolve, TYPING_SAVE_DELAY_MS + 50)));

/** Moves the focus out of `element`, as clicking elsewhere does. */
const leave = async (element: HTMLElement) => {
  act(() => element.blur());
  await settle();
};

const lastSaved = (): AdminSettings => saveAdminSettingsMock.mock.lastCall?.[0] as AdminSettings;

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

const SOURCE_STATUS = { languageCode: "en-US", languageName: "English (US)", cachedPages: 4, currentPages: 4, missingPages: 0, outdatedPages: 0, pendingPages: 0, totalPages: 4, unrecordedPages: 0, loading: null, sourceLanguage: true };
const GERMAN_STATUS = { languageCode: "de", languageName: "German", cachedPages: 4, currentPages: 4, missingPages: 0, outdatedPages: 0, pendingPages: 0, totalPages: 4, unrecordedPages: 0, loading: null, sourceLanguage: false };

const RUNNING_WARM_JOB = {
  id: "markdown-cache-1",
  status: "running",
  phase: "rendering",
  error: null,
  missingVariants: 4,
  processedVariants: 2,
  renderedVariants: 2,
  failedVariants: 0,
  etaSeconds: 30,
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
    fetchAdminLanguageTranslationOverviewMock.mockResolvedValue({ statuses: [SOURCE_STATUS], localizationPath: "localizations" });
    fetchAdminMarkdownCacheStatusMock.mockResolvedValue(MARKDOWN_CACHE_STATUS);
    fetchAdminMarkdownCacheWarmJobMock.mockResolvedValue(null);
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
    startAdminMarkdownCacheWarmJobMock.mockResolvedValue(RUNNING_WARM_JOB);
  });

  it("starts warming the Markdown cache in the background and follows its progress until it finishes", async () => {
    fetchAdminMarkdownCacheWarmJobMock.mockResolvedValueOnce(null).mockResolvedValue({ ...RUNNING_WARM_JOB, status: "completed", phase: "finished", processedVariants: 4, renderedVariants: 4, etaSeconds: null });

    const { container } = render(<AdminSettingsPanel />);
    const card = (): Element | null => container.querySelector(".panel-card-markdown-cache");
    await waitFor(() => expect(card()?.querySelector(".markdown-cache-idle button")).not.toBeNull(), { timeout: 3_000 });
    fireEvent.click(card()!.querySelector(".markdown-cache-idle button")!);
    await waitFor(() => expect(card()?.querySelector(".action-row .btn-primary")?.hasAttribute("disabled")).toBe(false));

    fireEvent.click(card()!.querySelector(".action-row .btn-primary")!);
    await waitFor(() => expect(card()?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50"));
    expect(startAdminMarkdownCacheWarmJobMock).toHaveBeenCalledTimes(1);
    expect(card()?.querySelector(".action-row .btn-primary")?.hasAttribute("disabled")).toBe(true);

    await waitFor(() => expect(card()?.querySelector(".success-text")).not.toBeNull(), { timeout: 3_000 });
    expect(card()?.querySelector('[role="progressbar"]')).toBeNull();
    // The status the admin opened is refreshed once the job finished.
    await waitFor(() => expect(fetchAdminMarkdownCacheStatusMock).toHaveBeenCalledTimes(2));
  });

  it("shows a Markdown cache job that is still running when the panel opens", async () => {
    fetchAdminMarkdownCacheWarmJobMock.mockResolvedValue({ ...RUNNING_WARM_JOB, processedVariants: 1 });

    const { container } = render(<AdminSettingsPanel />);

    await waitFor(() => expect(container.querySelector('.panel-card-markdown-cache [role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25"), { timeout: 3_000 });
    expect(fetchAdminMarkdownCacheStatusMock).not.toHaveBeenCalled();
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
    // No job ran since the server started: the overview alone reports the unrecorded translations.
    fetchAdminLanguageTranslationOverviewMock.mockResolvedValue({ statuses: [SOURCE_STATUS, { ...GERMAN_STATUS, unrecordedPages: 3 }], localizationPath: "localizations" });
    requestAdminSourceVersionRecordingMock.mockResolvedValue({ ...finishedJob, id: "source-versions", status: "running", phase: "checking", mode: "source-versions", finishedAt: null });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    const { container } = render(<AdminSettingsPanel />);
    const recordButton = await findElement<HTMLButtonElement>(container, ".translation-record-source-versions");

    fireEvent.click(recordButton);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(requestAdminSourceVersionRecordingMock).not.toHaveBeenCalled();

    // The job finishes; the overview loaded after it reports every translation as recorded.
    fetchAdminLanguageTranslationStatusMock.mockResolvedValue({ statuses: [], job: { ...finishedJob, id: "source-versions", mode: "source-versions" }, jobState: "current", updatedAt: "2026-03-10T12:02:00.000Z" });
    fetchAdminLanguageTranslationOverviewMock.mockResolvedValue({ statuses: [SOURCE_STATUS, GERMAN_STATUS], localizationPath: "localizations" });
    fireEvent.click(recordButton);
    await waitFor(() => expect(requestAdminSourceVersionRecordingMock).toHaveBeenCalledWith(3));
    await waitFor(() => expect(container.querySelector(".translation-record-source-versions")).toBeNull());
    expect(fetchAdminLanguageTranslationOverviewMock).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  });

  it("shows every language's status without a job, the source language's too, and follows a first fetch until it finished", async () => {
    fetchAdminLanguageTranslationOverviewMock
      .mockResolvedValueOnce({ statuses: [SOURCE_STATUS, { ...GERMAN_STATUS, currentPages: 0, pendingPages: 4, loading: { downloaded: 1, total: 4 } }], localizationPath: "localizations" })
      .mockResolvedValue({ statuses: [SOURCE_STATUS, { ...GERMAN_STATUS, currentPages: 3, missingPages: 1 }], localizationPath: "localizations" });

    const { container } = render(<AdminSettingsPanel />);
    const statusOf = (index: number): Element | null =>
      container.querySelectorAll(".translation-language-item:not(.translation-language-label-row) .translation-language-cache-status")[index] ?? null;

    await waitFor(() => expect(statusOf(1)?.getAttribute("aria-valuenow")).toBe("25"), { timeout: 3_000 });
    expect(statusOf(1)?.getAttribute("role")).toBe("progressbar");
    expect(statusOf(0)?.classList.contains("translation-language-cache-status-complete")).toBe(true);
    expect(fetchAdminLanguageTranslationStatusMock).toHaveBeenCalledTimes(1);

    // The card asks again while the language is fetched, and stops once its status is final.
    await waitFor(() => expect(statusOf(1)?.classList.contains("translation-language-cache-status-partial")).toBe(true), { timeout: 3_000 });
    expect(statusOf(1)?.getAttribute("role")).toBeNull();
    const overviewRequests = fetchAdminLanguageTranslationOverviewMock.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_800));
    });
    expect(fetchAdminLanguageTranslationOverviewMock).toHaveBeenCalledTimes(overviewRequests);
  });

  it("stops its requests when it unmounts and lets no late answer update it", async () => {
    const visitorStats = createDeferred<unknown>();
    fetchAdminVisitorStatsMock.mockImplementation(() => visitorStats.promise);
    const consoleError = vi.spyOn(console, "error");

    const { container, unmount } = render(<AdminSettingsPanel />);
    await findElement(container, ".panel-card-visitors");
    await waitFor(() => expect(fetchAdminLanguageTranslationOverviewMock).toHaveBeenCalled(), { timeout: 3_000 });
    const readMocks = [getCurrentUserMock, fetchAdminSettingsMock, fetchAdminModeratorsMock, fetchAdminDomainSslStatusMock, fetchAdminPerformanceStatsMock, fetchAdminVisitorStatsMock, fetchAdminMarkdownCacheWarmJobMock, fetchAdminLanguageTranslationOverviewMock];
    const signals = readMocks.flatMap((mock) => mock.mock.calls.map((call) => (call.at(-1) as { signal?: AbortSignal } | undefined)?.signal));
    expect(signals.length).toBeGreaterThanOrEqual(readMocks.length);
    expect(signals.every((signal) => signal instanceof AbortSignal && !signal.aborted)).toBe(true);

    unmount();

    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    await act(async () => {
      visitorStats.resolve({ stats: VISITOR_STATS, status: IDLE_VISITOR_STATUS });
      await visitorStats.promise;
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
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
    expect(fetchAdminVisitorStatsMock).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));

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
    saveAdminSettingsMock.mockImplementationOnce(() => firstSave.promise).mockImplementationOnce(() => secondSave.promise);

    const { container } = render(<AdminSettingsPanel />);
    const siteTitleInput = await findElement<HTMLInputElement>(container, "#site-title");
    siteTitleInput.focus();

    fireEvent.change(siteTitleInput, { target: { value: "Vicky Docs 1" } });
    await pauseTyping();
    expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);

    // The next pause asks for a follow-up, which waits for the save in flight.
    fireEvent.change(siteTitleInput, { target: { value: "Vicky Docs 12" } });
    await pauseTyping();
    expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
    expect(siteTitleInput.value).toBe("Vicky Docs 12");

    await act(async () => {
      firstSave.resolve({ ...INITIAL_SETTINGS, siteTitle: "Vicky Docs 1" });
      await firstSave.promise;
    });
    await waitFor(() => expect(saveAdminSettingsMock).toHaveBeenCalledTimes(2));
    expect(siteTitleInput.value).toBe("Vicky Docs 12");
    expect(lastSaved().siteTitle).toBe("Vicky Docs 12");

    await act(async () => {
      secondSave.resolve({ ...INITIAL_SETTINGS, siteTitle: "Vicky Docs 12" });
      await secondSave.promise;
    });
    expect(siteTitleInput.value).toBe("Vicky Docs 12");
  });

  it("keeps an open icon picker with its language when another row is removed or a language is added, and gives every row a fresh start on reset", async () => {
    saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => settings);
    fetchAdminSettingsMock.mockResolvedValue({
      ...INITIAL_SETTINGS,
      autoTranslateLanguages: [
        ...INITIAL_SETTINGS.autoTranslateLanguages,
        { name: "French", code: "fr", icon: "fr", enabled: true },
        { name: "Japanese", code: "ja", icon: "jp", enabled: true },
      ],
    });

    const { container } = render(<AdminSettingsPanel />);
    const codeAt = (index: number): string | undefined => container.querySelector<HTMLInputElement>(`#auto-translate-language-code-${index}`)?.value;
    const iconSearchAt = (index: number): string | undefined => container.querySelector<HTMLInputElement>(`#auto-translate-language-icon-${index}-search`)?.value;
    const openPickers = (): number => container.querySelectorAll(".circle-flag-picker-popover").length;
    // Clicked without a mousedown, as a keyboard activates them, so the open picker stays open.
    const clickRowAction = (selector: string) => fireEvent.click(container.querySelector(`.translation-language-list + .action-row ${selector}`)!);

    fireEvent.click(await findElement(container, "#auto-translate-language-icon-2"));
    fireEvent.change(await findElement(container, "#auto-translate-language-icon-2-search"), { target: { value: "jp" } });

    // German goes: French moves up with its picker, and Japanese's stays closed.
    fireEvent.click(container.querySelectorAll(".translation-language-remove")[1]);
    expect(codeAt(1)).toBe("fr");
    expect(iconSearchAt(1)).toBe("jp");
    expect(openPickers()).toBe(1);

    clickRowAction(".btn-secondary");
    expect(codeAt(3)).toBe("custom");
    expect(iconSearchAt(1)).toBe("jp");
    expect(openPickers()).toBe(1);

    clickRowAction(".btn-ghost");
    expect(codeAt(1)).toBe("de");
    expect(openPickers()).toBe(0);
  });

  it("clears saved GitHub token input before later settings saves", async () => {
    saveAdminSettingsMock.mockResolvedValue({ ...INITIAL_SETTINGS, tokenConfigured: true });

    const { container } = render(<AdminSettingsPanel />);
    const tokenInput = await findElement<HTMLInputElement>(container, "#github-token");
    tokenInput.focus();
    fireEvent.change(tokenInput, { target: { value: "ghp_saved" } });
    await leave(tokenInput);

    expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
    expect(lastSaved().githubToken).toBe("ghp_saved");
    expect(tokenInput.value).toBe("");

    const siteTitleInput = container.querySelector<HTMLInputElement>("#site-title")!;
    siteTitleInput.focus();
    fireEvent.change(siteTitleInput, { target: { value: "Vicky Docs without secret resend" } });
    await leave(siteTitleInput);

    expect(saveAdminSettingsMock).toHaveBeenCalledTimes(2);
    expect(lastSaved().githubToken).toBe("");
  });

  describe("a custom language row typed with the source language's ID", () => {
    it("stays an editable custom row that reports the duplicate until the ID is corrected, while the source row stays locked", async () => {
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => settings);

      const { container } = render(<AdminSettingsPanel />);
      fireEvent.click(await findElement(container, ".translation-language-list + .action-row .btn-secondary"));
      await settle();
      const codeInput = container.querySelector<HTMLInputElement>("#auto-translate-language-code-2")!;
      const row = codeInput.closest(".translation-language-item")!;
      const sourceCodeInput = container.querySelector<HTMLInputElement>("#auto-translate-language-code-0")!;
      const listError = (): Element | undefined =>
        Array.from(container.querySelector(".translation-language-list")!.parentElement!.children).find((element) => element.classList.contains("error-text"));
      const expectEditable = (value: string) => {
        expect(codeInput.value).toBe(value);
        expect(codeInput.disabled).toBe(false);
        expect(row.classList.contains("translation-language-item-fixed")).toBe(false);
        expect(row.querySelector<HTMLInputElement>(".translation-language-name-field input")?.disabled).toBe(false);
        expect(row.querySelector<HTMLButtonElement>(".translation-language-remove")?.disabled).toBe(false);
        expect(sourceCodeInput.disabled).toBe(true);
        expect(sourceCodeInput.closest(".translation-language-item")?.classList.contains("translation-language-item-fixed")).toBe(true);
      };

      codeInput.focus();
      for (const value of ["", "e", "en", "en-", "en-u", "en-us"]) {
        fireEvent.change(codeInput, { target: { value } });
        expectEditable(value);
        expect(document.activeElement).toBe(codeInput);
      }
      expect(listError()).toBeDefined();

      // Leaving the field normalizes the ID, and the row stays editable.
      await leave(codeInput);
      expectEditable("en-US");
      expect(listError()).toBeDefined();

      codeInput.focus();
      fireEvent.change(codeInput, { target: { value: "nl-be" } });
      expectEditable("nl-be");
      expect(listError()).toBeUndefined();
      await leave(codeInput);
      expect(lastSaved().autoTranslateLanguages.map((language) => language.code)).toEqual(["en-US", "de", "nl-BE"]);
    });
  });

  describe("a save's answer and the field being typed in", () => {
    it("never changes what is typed while the field has the focus, and shows what is stored once it is left", async () => {
      // Trims the title like the real server.
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => ({ ...settings, siteTitle: settings.siteTitle.trim() }));

      const { container } = render(<AdminSettingsPanel />);
      const titleInput = await findElement<HTMLInputElement>(container, "#site-title");
      titleInput.focus();

      for (const [value, saves] of [["Vicky Docs ", 1], ["Vicky Docs Hub", 2], ["Vicky Docs Hub ", 3]] as const) {
        fireEvent.change(titleInput, { target: { value } });
        await pauseTyping();
        expect(saveAdminSettingsMock).toHaveBeenCalledTimes(saves);
        expect(lastSaved().siteTitle).toBe(value);
        expect(titleInput.value).toBe(value);
        expect(document.activeElement).toBe(titleInput);
      }

      // Saved already: leaving the field shows the stored title without saving again.
      await leave(titleInput);
      expect(titleInput.value).toBe("Vicky Docs Hub");
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(3);
    });

    it("sends a field saved on leave only once it is left or confirmed, and keeps it as typed meanwhile", async () => {
      // Stores an empty branch as main and trims it, like the real server.
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => ({ ...settings, githubBranch: settings.githubBranch.trim() || "main" }));

      const { container } = render(<AdminSettingsPanel />);
      const branchInput = await findElement<HTMLInputElement>(container, "#repo-branch");
      branchInput.focus();
      fireEvent.change(branchInput, { target: { value: "" } });
      await pauseTyping();
      expect(saveAdminSettingsMock).not.toHaveBeenCalled();

      // A switch saves at once meanwhile: the save keeps the stored branch, and the field stays as typed.
      fireEvent.click(container.querySelector("#auto-translate-language-enabled-1")!);
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
      expect(lastSaved().githubBranch).toBe("main");
      await settle();
      expect(branchInput.value).toBe("");
      expect(document.activeElement).toBe(branchInput);

      // Enter saves it, and the field keeps it as typed.
      fireEvent.change(branchInput, { target: { value: "dev " } });
      fireEvent.keyDown(branchInput, { key: "Enter" });
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(2);
      expect(lastSaved().githubBranch).toBe("dev ");
      await settle();
      expect(branchInput.value).toBe("dev ");

      await leave(branchInput);
      expect(branchInput.value).toBe("dev");
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(2);
    });

    it("keeps a field as typed when only the window loses the focus, and saves what waits for a pause meanwhile", async () => {
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => ({ ...settings, siteTitle: settings.siteTitle.trim() }));

      const { container } = render(<AdminSettingsPanel />);
      const titleInput = await findElement<HTMLInputElement>(container, "#site-title");
      const repoInput = container.querySelector<HTMLInputElement>("#repo-name")!;

      // The focus stays in the field while another tab or app has the window's focus.
      titleInput.focus();
      fireEvent.change(titleInput, { target: { value: "Vicky Docs " } });
      fireEvent.focusOut(titleInput);
      await settle();
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
      expect(lastSaved().siteTitle).toBe("Vicky Docs ");
      expect(titleInput.value).toBe("Vicky Docs ");
      expect(document.activeElement).toBe(titleInput);

      // Really leaving it shows the stored title.
      repoInput.focus();
      await settle();
      expect(titleInput.value).toBe("Vicky Docs");

      // A field saved on leave waits until it is really left.
      fireEvent.change(repoInput, { target: { value: "Vicky-" } });
      fireEvent.focusOut(repoInput);
      await settle();
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
      expect(repoInput.value).toBe("Vicky-");
    });

    it("saves a slowly typed secret once its field is left, and empties the field after that", async () => {
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => ({ ...settings, githubToken: "", tokenConfigured: true }));

      const { container } = render(<AdminSettingsPanel />);
      const tokenInput = await findElement<HTMLInputElement>(container, "#github-token");
      tokenInput.focus();
      for (const value of ["ghp_", "ghp_abc"]) {
        fireEvent.change(tokenInput, { target: { value } });
        await pauseTyping();
        expect(tokenInput.value).toBe(value);
      }
      expect(saveAdminSettingsMock).not.toHaveBeenCalled();

      await leave(tokenInput);
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
      expect(lastSaved().githubToken).toBe("ghp_abc");
      expect(tokenInput.value).toBe("");
    });

    it("drops a typed secret when its Clear button is clicked instead of saving it first", async () => {
      fetchAdminSettingsMock.mockResolvedValue({ ...INITIAL_SETTINGS, tokenConfigured: true });
      clearAdminGitHubTokenMock.mockResolvedValue(INITIAL_SETTINGS);

      const { container } = render(<AdminSettingsPanel />);
      const tokenInput = await findElement<HTMLInputElement>(container, "#github-token");
      const clearButton = container.querySelector<HTMLButtonElement>("#github-token + .secret-clear-button")!;
      tokenInput.focus();
      fireEvent.change(tokenInput, { target: { value: "ghp_mistake" } });

      // Pressing the button leaves the focus in the field, so leaving it saves nothing.
      expect(fireEvent.mouseDown(clearButton)).toBe(false);
      fireEvent.click(clearButton);
      await settle();
      expect(clearAdminGitHubTokenMock).toHaveBeenCalledTimes(1);
      expect(saveAdminSettingsMock).not.toHaveBeenCalled();
      expect(tokenInput.value).toBe("");
    });
  });

  describe("when what is typed is saved", () => {
    it("saves typed text once typing pauses, not per keystroke", async () => {
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => settings);

      const { container } = render(<AdminSettingsPanel />);
      const titleInput = await findElement<HTMLInputElement>(container, "#site-title");
      titleInput.focus();
      const sentence = "Vicky Docs for everyone";
      for (let length = 11; length <= sentence.length; length += 1) {
        fireEvent.change(titleInput, { target: { value: sentence.slice(0, length) } });
      }

      await act(() => new Promise((resolve) => setTimeout(resolve, TYPING_SAVE_DELAY_MS / 2)));
      expect(saveAdminSettingsMock).not.toHaveBeenCalled();
      await pauseTyping();
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
      expect(lastSaved().siteTitle).toBe(sentence);
    });

    it("saves a language ID only once it is left or confirmed, so the overview is not loaded again per keystroke", async () => {
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => settings);

      const { container } = render(<AdminSettingsPanel />);
      await waitFor(() => expect(fetchAdminLanguageTranslationOverviewMock).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      fireEvent.click(container.querySelector(".translation-language-list + .action-row .btn-secondary")!);
      await waitFor(() => expect(fetchAdminLanguageTranslationOverviewMock).toHaveBeenCalledTimes(2));
      const savesAfterAdding = saveAdminSettingsMock.mock.calls.length;
      const codeInput = container.querySelector<HTMLInputElement>("#auto-translate-language-code-2")!;

      codeInput.focus();
      for (const value of ["custo", "cust", "cus", "cu", "c", "", "n", "nl", "nl-", "nl-b", "nl-be"]) {
        fireEvent.change(codeInput, { target: { value } });
      }
      await pauseTyping();
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(savesAfterAdding);
      expect(fetchAdminLanguageTranslationOverviewMock).toHaveBeenCalledTimes(2);

      // Enter saves it; the field keeps it as typed and keeps the focus.
      fireEvent.keyDown(codeInput, { key: "Enter" });
      await settle();
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(savesAfterAdding + 1);
      expect(lastSaved().autoTranslateLanguages[2]?.code).toBe("nl-BE");
      expect(codeInput.value).toBe("nl-be");
      expect(document.activeElement).toBe(codeInput);
      await waitFor(() => expect(fetchAdminLanguageTranslationOverviewMock).toHaveBeenCalledTimes(3));

      // Leaving it shows the ID as stored, without saving it again.
      await leave(codeInput);
      expect(codeInput.value).toBe("nl-BE");
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(savesAfterAdding + 1);
      expect(fetchAdminLanguageTranslationOverviewMock).toHaveBeenCalledTimes(3);
    });

    it("lets an action wait until everything typed before it is saved, a save already in flight included", async () => {
      const firstSave = createDeferred<AdminSettings>();
      const secondSave = createDeferred<AdminSettings>();
      saveAdminSettingsMock.mockImplementationOnce(() => firstSave.promise).mockImplementationOnce(() => secondSave.promise);

      const { container } = render(<AdminSettingsPanel />);
      const titleInput = await findElement<HTMLInputElement>(container, "#site-title");
      titleInput.focus();
      fireEvent.change(titleInput, { target: { value: "Vicky Docs 1" } });
      await pauseTyping();
      fireEvent.change(titleInput, { target: { value: "Vicky Docs 12" } });

      // "Fetch pages now" reads the saved settings on the server.
      fireEvent.click(container.querySelector(".panel-card-repo .action-row .btn")!);
      await settle();
      expect(refreshAdminDocsCacheMock).not.toHaveBeenCalled();

      await act(async () => {
        firstSave.resolve({ ...INITIAL_SETTINGS, siteTitle: "Vicky Docs 1" });
        await firstSave.promise;
      });
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(2);
      expect(lastSaved().siteTitle).toBe("Vicky Docs 12");
      expect(refreshAdminDocsCacheMock).not.toHaveBeenCalled();

      await act(async () => {
        secondSave.resolve({ ...INITIAL_SETTINGS, siteTitle: "Vicky Docs 12" });
        await secondSave.promise;
      });
      await waitFor(() => expect(refreshAdminDocsCacheMock).toHaveBeenCalledTimes(1));
    });

    it("saves what was just typed when the panel unmounts", async () => {
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => settings);

      const { container, unmount } = render(<AdminSettingsPanel />);
      const titleInput = await findElement<HTMLInputElement>(container, "#site-title");
      titleInput.focus();
      fireEvent.change(titleInput, { target: { value: "Vicky Docs unmounted" } });
      expect(saveAdminSettingsMock).not.toHaveBeenCalled();

      unmount();
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
      expect(lastSaved().siteTitle).toBe("Vicky Docs unmounted");
    });

    it("sends what was just typed at once when the page unloads, beside a save still in flight", async () => {
      const firstSave = createDeferred<AdminSettings>();
      saveAdminSettingsMock.mockImplementationOnce(() => firstSave.promise).mockImplementation(async (settings: AdminSettings) => settings);

      const { container } = render(<AdminSettingsPanel />);
      const titleInput = await findElement<HTMLInputElement>(container, "#site-title");
      const repoInput = container.querySelector<HTMLInputElement>("#repo-name")!;
      titleInput.focus();
      fireEvent.change(titleInput, { target: { value: "Vicky Docs 1" } });
      await pauseTyping();
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);

      // A field saved on leave, typed in while the page unloads.
      repoInput.focus();
      fireEvent.change(repoInput, { target: { value: "Vicky-next" } });
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event("pagehide"));
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(2);
      expect(lastSaved()).toMatchObject({ siteTitle: "Vicky Docs 1", githubRepo: "Vicky-next" });

      await act(async () => {
        firstSave.resolve({ ...INITIAL_SETTINGS, siteTitle: "Vicky Docs 1" });
        await firstSave.promise;
      });
    });

    it("saves a switch at once", async () => {
      saveAdminSettingsMock.mockImplementation(async (settings: AdminSettings) => settings);

      const { container } = render(<AdminSettingsPanel />);
      fireEvent.click(await findElement(container, "#auto-translate-language-enabled-1"));
      expect(saveAdminSettingsMock).toHaveBeenCalledTimes(1);
      expect(lastSaved().autoTranslateLanguages[1]?.enabled).toBe(false);
    });
  });
});
