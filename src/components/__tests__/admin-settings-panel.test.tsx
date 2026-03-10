// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSettings, DomainSslRuntimeStatus } from "@/components/types";

import { AdminSettingsPanel } from "../admin-settings-panel";

const replaceMock = vi.fn();
const setThemeSettingsMock = vi.fn();
const fetchAdminDomainSslStatusMock = vi.fn();
const fetchAdminSettingsMock = vi.fn();
const getCurrentUserMock = vi.fn();
const logoutMock = vi.fn();
const saveAdminSettingsMock = vi.fn();
const testAdminConnectionMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({
    setThemeSettings: setThemeSettingsMock,
  }),
}));

vi.mock("@/components/api", () => ({
  fetchAdminDomainSslStatus: (...args: unknown[]) => fetchAdminDomainSslStatusMock(...args),
  fetchAdminSettings: (...args: unknown[]) => fetchAdminSettingsMock(...args),
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : "Something went wrong. Please try again."),
  getCurrentUser: (...args: unknown[]) => getCurrentUserMock(...args),
  logout: (...args: unknown[]) => logoutMock(...args),
  saveAdminSettings: (...args: unknown[]) => saveAdminSettingsMock(...args),
  testAdminConnection: (...args: unknown[]) => testAdminConnectionMock(...args),
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
  docsCacheTtlSeconds: 30,
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
  themeLightAccent: "#006ecf",
  themeLightSurfaceAccent: "#7db8f0",
  themeDarkAccent: "#5caedf",
  themeDarkSurfaceAccent: "#47729c",
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

describe("AdminSettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentUserMock.mockResolvedValue({ role: "admin" });
    fetchAdminSettingsMock.mockResolvedValue(INITIAL_SETTINGS);
    fetchAdminDomainSslStatusMock.mockResolvedValue(SSL_STATUS);
    logoutMock.mockResolvedValue(undefined);
    testAdminConnectionMock.mockResolvedValue("ok");
  });

  it("keeps the newest typed value when an older autosave response resolves later", async () => {
    const firstSave = createDeferred<AdminSettings>();
    const secondSave = createDeferred<AdminSettings>();

    saveAdminSettingsMock
      .mockImplementationOnce(() => firstSave.promise)
      .mockImplementationOnce(() => secondSave.promise);

    render(<AdminSettingsPanel />);

    const siteTitleInput = (await screen.findByLabelText("Site title")) as HTMLInputElement;

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
