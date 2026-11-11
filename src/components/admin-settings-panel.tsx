"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createAdminModerator,
  deleteAdminModerator,
  formatApiError,
  MAX_DOCS_REFRESH_INTERVAL_MINUTES,
  MIN_DOCS_REFRESH_INTERVAL_MINUTES,
  refreshAdminDocsCache,
  testAdminConnection,
  updateAdminModerator,
} from "@/components/api";
import { formatCount, formatStatusTimestamp } from "@/components/admin-settings/format";
import { useLocalizationRequests } from "@/components/admin-settings/localization-requests";
import {
  getTranslationStatusProgressPercent,
  isTranslationStatusPending,
  translationCacheStatusKey,
} from "@/components/admin-settings/localization-status";
import { MarkdownCacheCard } from "@/components/admin-settings/markdown-cache-card";
import { useAdminPanel, useLocalizationContext, usePanelLoad, useSslStatusContext } from "@/components/admin-settings/panel-context";
import { AdminPanelProvider } from "@/components/admin-settings/panel-provider";
import { PerformanceStatsCard } from "@/components/admin-settings/performance-stats-card";
import { EnabledToggle, ResetToDefaultButton } from "@/components/admin-settings/settings-fields";
import { themeCustomizationFromSettings, useSettingsSelector, type SettingsState } from "@/components/admin-settings/settings-store";
import {
  normalizeAutoTranslateRequestTimeoutSeconds,
  validateAutoTranslateLanguages,
  validateAutoTranslateRequestTimeoutSeconds,
  validateCustomDomainInput,
  validateLetsEncryptEmailInput,
  validateLocalizationPathInput,
  validateOpenRouterApiKeyInput,
  validateOpenRouterModelInput,
  validateSystemPromptInput,
  type AiChatFieldErrors,
  type AutoTranslateFieldErrors,
  type DomainFieldErrors,
  type OpenRouterFieldErrors,
} from "@/components/admin-settings/settings-validation";
import { VisitorStatsCard } from "@/components/admin-settings/visitor-stats-card";
import { CircleFlagIconPicker } from "@/components/circle-flag-icon-picker";
import { ColorPickerField } from "@/components/color-picker-field";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState, LoadingState } from "@/components/states";
import {
  AI_CHAT_ASSISTANT_NAME_PLACEHOLDER,
  AI_CHAT_DOCS_PLACEHOLDER,
  DEFAULT_AI_CHAT_ASSISTANT_NAME,
  DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  DEFAULT_AI_CHAT_OPENROUTER_MODEL,
  DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
} from "@/lib/ai-chat";
import {
  DEFAULT_AUTO_TRANSLATE_FALLBACK_LANGUAGE_ICON,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGES,
  DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  DEFAULT_LOCALIZATION_PATH,
  MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  getDefaultAutoTranslateLanguageIcon,
  isDefaultAutoTranslateLanguageCode,
  languageCodesEqual,
  normalizeAutoTranslateLanguageCode,
  normalizeLocalizationPath,
} from "@/lib/auto-translate";
import type {
  AdminLanguageTranslationCacheStatus,
  AdminTranslationJobLogEntry,
  AdminTranslationJobSnapshot,
  AutoTranslateLanguage,
  DomainSslRuntimeStatus,
  ModeratorAccount,
  ThemeCustomization,
} from "@/components/types";
import { normalizeCircleFlagIconId } from "@/lib/circle-flags";
import { DEFAULT_FOOTER_TEXT } from "@/lib/footer";
import { buildThemeVariables, DEFAULT_THEME_CUSTOMIZATION } from "@/lib/theme";

const THEME_DEFAULTS = DEFAULT_THEME_CUSTOMIZATION();
const DEFAULT_SITE_TITLE_GRADIENT_FROM = "#3b82f6";
const DEFAULT_SITE_TITLE_GRADIENT_TO = "#22d3ee";

const createCustomAutoTranslateLanguage = (languages: AutoTranslateLanguage[]): AutoTranslateLanguage => {
  let index = 1;
  let code = "custom";

  while (languages.some((language) => languageCodesEqual(language.code, code))) {
    index += 1;
    code = `custom-${index}`;
  }

  return {
    name: "Custom Language",
    code,
    icon: DEFAULT_AUTO_TRANSLATE_FALLBACK_LANGUAGE_ICON,
    enabled: true,
  };
};

const createThemePreviewStyle = (
  mode: "light" | "dark",
  customization: ThemeCustomization,
): CSSProperties => {
  const variables = buildThemeVariables(mode, customization);

  return {
    "--theme-preview-surface": variables["--surface"],
    "--theme-preview-surface-muted": variables["--surface-muted"],
    "--theme-preview-text": variables["--text-primary"],
    "--theme-preview-text-secondary": variables["--text-secondary"],
    "--theme-preview-border": variables["--border"],
    "--theme-preview-page-gradient": variables["--page-gradient"],
    "--theme-preview-accent-primary": variables["--accent"],
    "--theme-preview-accent-primary-soft": variables["--accent-soft"],
    "--theme-preview-accent-primary-contrast": variables["--accent-contrast"],
    "--theme-preview-accent-surface": variables["--accent-surface"],
    "--theme-preview-accent-surface-soft": variables["--accent-surface-soft"],
    "--theme-preview-accent-surface-contrast": variables["--accent-surface-contrast"],
  } as CSSProperties;
};

const statusToneClassName = (status: DomainSslRuntimeStatus): "success-text" | "warning-text" | "error-text" => {
  if (status.configured && !status.httpsAvailable) {
    return "error-text";
  }

  switch (status.certificateState) {
    case "valid":
      return "success-text";
    case "expiring_soon":
    case "missing":
      return "warning-text";
    case "expired":
    case "domain_mismatch":
    case "invalid":
      return "error-text";
    default:
      return "warning-text";
  }
};

const formatCustomDomainHttpPolicy = (status: DomainSslRuntimeStatus): string => {
  switch (status.customDomainHttpPolicy) {
    case "redirect":
      return "redirect to HTTPS";
    case "maintenance":
      return "fail-closed maintenance response";
    default:
      return "serve application";
  }
};

type TranslationCacheStatusTone = "loading" | "empty" | "partial" | "complete";

const getTranslationJobStatusLabel = (job: AdminTranslationJobSnapshot | null): string => {
  if (!job) {
    return "Idle";
  }

  if (job.status === "running") {
    if (job.phase === "queued") {
      return "Queued";
    }

    if (job.phase === "checking") {
      return "Checking";
    }

    return job.phase === "uploading" ? "Uploading" : "Translating";
  }

  if (job.status === "completed") {
    return "Complete";
  }

  if (job.status === "completed_with_failures") {
    return "Complete with failures";
  }

  return "Failed";
};

const getTranslationJobStatusTone = (
  job: AdminTranslationJobSnapshot | null,
): "loading" | "complete" | "partial" | "empty" => {
  if (!job || job.status === "running") {
    return "loading";
  }

  if (job.status === "completed") {
    return "complete";
  }

  return job.status === "completed_with_failures" ? "partial" : "empty";
};

const getTranslationLogIcon = (level: AdminTranslationJobLogEntry["level"]): string => {
  if (level === "success") {
    return "check_circle";
  }

  if (level === "warning") {
    return "warning";
  }

  if (level === "error") {
    return "error";
  }

  return "info";
};

const getTranslationCacheStatusTone = (
  status: AdminLanguageTranslationCacheStatus | undefined,
): TranslationCacheStatusTone => {
  if (!status || isTranslationStatusPending(status)) {
    return "loading";
  }

  if (status.totalPages === 0 || status.currentPages >= status.totalPages) {
    return "complete";
  }

  return status.currentPages === 0 ? "empty" : "partial";
};

const getTranslationCacheStatusLabel = (status: AdminLanguageTranslationCacheStatus | undefined): string => {
  if (!status) {
    return "...";
  }

  if (isTranslationStatusPending(status)) {
    const percent = getTranslationStatusProgressPercent(status);
    return percent === null ? "..." : `${percent}%`;
  }

  return `${status.currentPages}/${status.totalPages}`;
};

const getTranslationCacheStatusTooltip = (status: AdminLanguageTranslationCacheStatus | undefined): string => {
  if (!status) {
    return "Checking localization status";
  }

  if (status.sourceLanguage) {
    return `Source language: all ${formatCount(status.totalPages)} page${status.totalPages === 1 ? "" : "s"} are written in it`;
  }

  if (isTranslationStatusPending(status)) {
    const loading = status.loading;
    if (loading && loading.total > 0 && loading.downloaded < loading.total) {
      return `Fetching this language's translations from GitHub for the first time: ${formatCount(loading.downloaded)} of ${formatCount(loading.total)} files`;
    }
    return "Checking on GitHub when this language's translations were last changed";
  }

  return `${status.currentPages}/${status.totalPages} current, ${status.missingPages} missing, ${status.outdatedPages} outdated`;
};

export function AdminSettingsPanel() {
  return (
    <AdminPanelProvider>
      <AdminSettingsContent />
    </AdminPanelProvider>
  );
}

function AdminSettingsContent() {
  const { loadError, loading } = usePanelLoad();

  if (loading) {
    return <LoadingState label="Loading admin settings..." />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="Unable to load admin settings"
        message={loadError}
        actionLabel="Retry"
        onAction={() => window.location.reload()}
      />
    );
  }

  return <AdminSettingsCards />;
}

const selectSettingsState = (state: SettingsState): SettingsState => state;

function AdminSettingsCards() {
  const { initialModerators } = usePanelLoad();
  const services = useAdminPanel();
  const { clearSavedSecret, lifetimeSignal, persistLatestSettings, refreshRequestedMarkdownCacheStatus, refreshTranslationOverview, settingsStore } = services;
  const { clearingSecret, draft: settings, errors, saveError, saving: settingsSaving } = useSettingsSelector(selectSettingsState);
  const setSettings = settingsStore.updateDraft;
  const domainFieldErrors = errors.domain;
  const aiChatFieldErrors = errors.aiChat;
  const openRouterFieldErrors = errors.openRouter;
  const autoTranslateFieldErrors = errors.autoTranslate;
  const setDomainFieldErrors = (update: (prev: DomainFieldErrors) => DomainFieldErrors) => settingsStore.patchErrors("domain", update(settingsStore.getState().errors.domain));
  const setAiChatFieldErrors = (update: (prev: AiChatFieldErrors) => AiChatFieldErrors) => settingsStore.patchErrors("aiChat", update(settingsStore.getState().errors.aiChat));
  const setOpenRouterFieldErrors = (update: (prev: OpenRouterFieldErrors) => OpenRouterFieldErrors) =>
    settingsStore.patchErrors("openRouter", update(settingsStore.getState().errors.openRouter));
  const setAutoTranslateFieldErrors = (update: (prev: AutoTranslateFieldErrors) => AutoTranslateFieldErrors) =>
    settingsStore.patchErrors("autoTranslate", update(settingsStore.getState().errors.autoTranslate));
  const { error: sslStatusError, loading: sslStatusLoading, status: sslStatus } = useSslStatusContext();
  const localization = useLocalizationContext();
  const {
    job: translationJob,
    requestStatus: translationRequestStatus,
    statusError: translationCacheStatusError,
    statusLoading: translationCacheStatusLoading,
    statuses: translationCacheStatuses,
    statusesLocalizationPath: translationStatusesLocalizationPath,
  } = localization;
  const {
    bulkAction: translationBulkAction,
    recordSourceVersions: recordSourceVersionsOf,
    requestBulkTranslations,
    requestLanguageTranslations,
    requestedLanguageCodes: requestedTranslationLanguageCodes,
  } = useLocalizationRequests(services, localization);

  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [refreshingDocs, setRefreshingDocs] = useState(false);
  const [docsRefreshMessage, setDocsRefreshMessage] = useState<string | null>(null);
  const [docsRefreshError, setDocsRefreshError] = useState<string | null>(null);

  const [moderators, setModerators] = useState<ModeratorAccount[]>(initialModerators);
  const [moderatorUsername, setModeratorUsername] = useState("");
  const [moderatorPassword, setModeratorPassword] = useState("");
  const [showModeratorPassword, setShowModeratorPassword] = useState(false);
  const [moderatorError, setModeratorError] = useState<string | null>(null);
  const [moderatorSaving, setModeratorSaving] = useState(false);
  const [moderatorActionId, setModeratorActionId] = useState<string | null>(null);
  const [editingModeratorId, setEditingModeratorId] = useState<string | null>(null);
  const [editingModeratorUsername, setEditingModeratorUsername] = useState("");
  const [editingModeratorPassword, setEditingModeratorPassword] = useState("");
  const [showEditingModeratorPassword, setShowEditingModeratorPassword] = useState(false);
  const translationLogRef = useRef<HTMLDivElement | null>(null);

  const themeCustomization = useMemo(() => themeCustomizationFromSettings(settings), [settings]);
  const lightPreviewStyle = useMemo(
    () => createThemePreviewStyle("light", themeCustomization),
    [themeCustomization],
  );
  const darkPreviewStyle = useMemo(
    () => createThemePreviewStyle("dark", themeCustomization),
    [themeCustomization],
  );
  const activeTranslationMode = translationJob?.status === "running" ? translationJob.mode : translationBulkAction;
  const translationLogEntries = translationJob?.logs ?? [];
  /** Current translations that do not record their source version yet, as the overview or a running job reports them. */
  const unrecordedTranslationCount = useMemo(
    () =>
      settings.autoTranslateLanguages.reduce(
        (total, language) =>
          isDefaultAutoTranslateLanguageCode(language.code) ? total : total + (translationCacheStatuses[translationCacheStatusKey(language.code)]?.unrecordedPages ?? 0),
        0,
      ),
    [settings.autoTranslateLanguages, translationCacheStatuses],
  );
  const recordSourceVersions = () => recordSourceVersionsOf(unrecordedTranslationCount);

  const resetModeratorEditor = useCallback(() => {
    setEditingModeratorId(null);
    setEditingModeratorUsername("");
    setEditingModeratorPassword("");
    setShowEditingModeratorPassword(false);
  }, []);

  const handleCreateModerator = useCallback(async () => {
    const signal = lifetimeSignal();
    setModeratorSaving(true);
    setModeratorError(null);

    try {
      const created = await createAdminModerator({
        username: moderatorUsername,
        password: moderatorPassword,
      });
      if (signal.aborted) {
        return;
      }
      setModerators((prev) => [...prev, created].sort((left, right) => left.username.localeCompare(right.username)));
      setModeratorUsername("");
      setModeratorPassword("");
      setShowModeratorPassword(false);
    } catch (error) {
      if (!signal.aborted) {
        setModeratorError(formatApiError(error));
      }
    } finally {
      if (!signal.aborted) {
        setModeratorSaving(false);
      }
    }
  }, [lifetimeSignal, moderatorPassword, moderatorUsername]);

  const handleUpdateModerator = useCallback(
    async (account: ModeratorAccount) => {
      const username = editingModeratorUsername.trim();
      if (!username) {
        setModeratorError("Moderator username is required.");
        return;
      }

      const payload: { username?: string; password?: string } = {};
      if (username !== account.username) {
        payload.username = username;
      }

      if (editingModeratorPassword) {
        payload.password = editingModeratorPassword;
      }

      if (!payload.username && !payload.password) {
        resetModeratorEditor();
        return;
      }

      const signal = lifetimeSignal();
      setModeratorActionId(account.id);
      setModeratorError(null);

      try {
        const updated = await updateAdminModerator(account.id, payload);
        if (signal.aborted) {
          return;
        }
        setModerators((prev) =>
          prev
            .map((moderator) => (moderator.id === account.id ? updated : moderator))
            .sort((left, right) => left.username.localeCompare(right.username)),
        );
        resetModeratorEditor();
      } catch (error) {
        if (!signal.aborted) {
          setModeratorError(formatApiError(error));
        }
      } finally {
        if (!signal.aborted) {
          setModeratorActionId(null);
        }
      }
    },
    [editingModeratorPassword, editingModeratorUsername, lifetimeSignal, resetModeratorEditor],
  );

  const handleDeleteModerator = useCallback(
    async (account: ModeratorAccount) => {
      const signal = lifetimeSignal();
      setModeratorActionId(account.id);
      setModeratorError(null);

      try {
        await deleteAdminModerator(account.id);
        if (signal.aborted) {
          return;
        }
        setModerators((prev) => prev.filter((moderator) => moderator.id !== account.id));
        if (editingModeratorId === account.id) {
          resetModeratorEditor();
        }
      } catch (error) {
        if (!signal.aborted) {
          setModeratorError(formatApiError(error));
        }
      } finally {
        if (!signal.aborted) {
          setModeratorActionId(null);
        }
      }
    },
    [editingModeratorId, lifetimeSignal, resetModeratorEditor],
  );

  const refreshDocsCache = useCallback(async () => {
    const signal = lifetimeSignal();
    setRefreshingDocs(true);
    setDocsRefreshMessage(null);
    setDocsRefreshError(null);

    try {
      await persistLatestSettings();
      const result = await refreshAdminDocsCache();
      if (signal.aborted) {
        return;
      }
      setDocsRefreshMessage(
        `Fetched ${formatCount(result.pageCount)} page${result.pageCount === 1 ? "" : "s"}. Cache expires ${formatStatusTimestamp(result.expiresAt)}.`,
      );
      void refreshTranslationOverview();
      refreshRequestedMarkdownCacheStatus();
    } catch (error) {
      if (!signal.aborted) {
        setDocsRefreshError(formatApiError(error));
      }
    } finally {
      if (!signal.aborted) {
        setRefreshingDocs(false);
      }
    }
  }, [lifetimeSignal, persistLatestSettings, refreshRequestedMarkdownCacheStatus, refreshTranslationOverview]);

  useEffect(() => {
    const logElement = translationLogRef.current;
    if (!logElement) {
      return;
    }

    logElement.scrollTop = logElement.scrollHeight;
  }, [translationLogEntries.length, translationJob?.id]);

  return (
    <section className="admin-page">
      {saveError ? <p className="error-text">{saveError}</p> : null}

      <div className="panel-grid">
        <div className="panel-stack-left">
          <PerformanceStatsCard />

          <section className="panel-card panel-card-repo">
          <div className="panel-header">
            <h1>Repository Settings</h1>
          </div>

          <p className="panel-description">
            Configure repository connectivity, write credentials, and docs refresh behavior.
          </p>

          <div className="form-grid">
            <div className="settings-subcard">
              <div className="settings-subcard-fields">
                <label className="field-row" htmlFor="docs-refresh-interval-minutes">
                  <span className="field-label">Docs refresh interval (minutes)</span>
                  <input
                    id="docs-refresh-interval-minutes"
                    className="input"
                    type="number"
                    min={MIN_DOCS_REFRESH_INTERVAL_MINUTES}
                    max={MAX_DOCS_REFRESH_INTERVAL_MINUTES}
                    step={1}
                    value={settings.docsRefreshIntervalMinutes}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      const normalized = Number.isFinite(parsed) ? Math.min(MAX_DOCS_REFRESH_INTERVAL_MINUTES, Math.max(MIN_DOCS_REFRESH_INTERVAL_MINUTES, parsed)) : MIN_DOCS_REFRESH_INTERVAL_MINUTES;
                      setSettings((prev) => ({ ...prev, docsRefreshIntervalMinutes: normalized }));
                    }}
                    required
                  />
                  <span className="field-hint">
                    {MIN_DOCS_REFRESH_INTERVAL_MINUTES} to {MAX_DOCS_REFRESH_INTERVAL_MINUTES} minutes (24 hours). Vicky checks GitHub for changes once per interval and only downloads pages that changed.
                  </span>
                </label>
              </div>
            </div>

            <div className="settings-subcard">
              <div className="settings-subcard-fields">
                <div className="field-row">
                  <label className="field-label" htmlFor="github-token">
                    GitHub token
                  </label>
                  <div className="secret-input-row">
                    <input
                      id="github-token"
                      className="input"
                      type="text"
                      autoComplete="off"
                      value={settings.githubToken}
                      onChange={(event) => {
                        setSettings((prev) => ({ ...prev, githubToken: event.target.value }));
                      }}
                      placeholder={
                        settings.tokenConfigured ? "Saved token configured (leave blank to keep)" : "github_pat_... or ghp_..."
                      }
                    />
                    <button
                      type="button"
                      className="btn secret-clear-button"
                      disabled={
                        settingsSaving ||
                        clearingSecret !== null ||
                        (!settings.githubToken.trim() && !settings.tokenConfigured)
                      }
                      onClick={() => {
                        void clearSavedSecret("githubToken");
                      }}
                    >
                      {clearingSecret === "githubToken" ? "Clearing..." : "Clear"}
                    </button>
                  </div>
                  <span className="field-hint">
                    Use a PAT for this repo. Minimum permissions: Contents (read/write) and Metadata (read-only).
                  </span>
                </div>
              </div>
            </div>

            <div className="settings-subcard">
              <div className="settings-subcard-fields">
                <div className="field-inline">
                  <label className="field-row" htmlFor="repo-owner">
                    <span className="field-label">Owner</span>
                    <input
                      id="repo-owner"
                      className="input"
                      value={settings.githubOwner}
                      onChange={(event) => setSettings((prev) => ({ ...prev, githubOwner: event.target.value }))}
                      required
                    />
                    <span className="field-hint">
                      GitHub user or org name only. Example: <code>Keksuccino</code>.
                    </span>
                  </label>
                  <label className="field-row" htmlFor="repo-name">
                    <span className="field-label">Repository</span>
                    <input
                      id="repo-name"
                      className="input"
                      value={settings.githubRepo}
                      onChange={(event) => setSettings((prev) => ({ ...prev, githubRepo: event.target.value }))}
                      required
                    />
                    <span className="field-hint">
                      Repository name only. Example: <code>Vicky</code> (no owner, no <code>.git</code>).
                    </span>
                  </label>
                </div>

                <div className="field-inline">
                  <label className="field-row" htmlFor="repo-branch">
                    <span className="field-label">Branch</span>
                    <input
                      id="repo-branch"
                      className="input"
                      value={settings.githubBranch}
                      onChange={(event) => setSettings((prev) => ({ ...prev, githubBranch: event.target.value }))}
                      required
                    />
                    <span className="field-hint">
                      Existing branch name. Example: <code>main</code>.
                    </span>
                  </label>
                  <label className="field-row" htmlFor="docs-path">
                    <span className="field-label">Docs path</span>
                    <input
                      id="docs-path"
                      className="input"
                      value={settings.githubDocsPath}
                      onChange={(event) => setSettings((prev) => ({ ...prev, githubDocsPath: event.target.value }))}
                      required
                    />
                    <span className="field-hint">
                      Folder inside the repo where markdown files live. Example: <code>docs</code>.
                    </span>
                  </label>
                </div>

                <div className="action-row">
                  <button type="button" className="btn" disabled={refreshingDocs} onClick={refreshDocsCache}>
                    <MaterialIcon name={refreshingDocs ? "sync" : "cloud_sync"} />
                    <span>{refreshingDocs ? "Fetching..." : "Fetch pages now"}</span>
                  </button>

                  <button
                    type="button"
                    className="btn"
                    disabled={testingConnection}
                    onClick={async () => {
                      const signal = lifetimeSignal();
                      setTestingConnection(true);
                      setConnectionMessage(null);
                      setConnectionError(null);

                      try {
                        const message = await testAdminConnection(settings, { signal });
                        if (!signal.aborted) {
                          setConnectionMessage(message);
                        }
                      } catch (error) {
                        if (!signal.aborted) {
                          setConnectionError(formatApiError(error));
                        }
                      } finally {
                        if (!signal.aborted) {
                          setTestingConnection(false);
                        }
                      }
                    }}
                  >
                    <MaterialIcon name={testingConnection ? "hourglass_top" : "network_check"} />
                    <span>{testingConnection ? "Testing..." : "Test connection"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {connectionMessage ? <p className="success-text">{connectionMessage}</p> : null}
          {connectionError ? <p className="error-text">{connectionError}</p> : null}
          {docsRefreshMessage ? <p className="success-text">{docsRefreshMessage}</p> : null}
          {docsRefreshError ? <p className="error-text">{docsRefreshError}</p> : null}
          </section>

          <MarkdownCacheCard />

          <section className="panel-card panel-card-moderators">
            <div className="panel-header">
              <h2>Moderator Accounts</h2>
            </div>

            <p className="panel-description">
              Create Moderator accounts. Moderators only have access to the editor, not the admin panel.
            </p>

            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateModerator();
              }}
            >
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-inline">
                    <label className="field-row" htmlFor="moderator-username">
                      <span className="field-label">Username</span>
                      <input
                        id="moderator-username"
                        className="input"
                        value={moderatorUsername}
                        onChange={(event) => setModeratorUsername(event.target.value)}
                        placeholder="docs-editor"
                        autoComplete="off"
                        required
                      />
                    </label>

                    <div className="field-row">
                      <label className="field-label" htmlFor="moderator-password">
                        Password
                      </label>
                      <div className="password-input-row">
                        <input
                          id="moderator-password"
                          className="input"
                          type={showModeratorPassword ? "text" : "password"}
                          value={moderatorPassword}
                          onChange={(event) => setModeratorPassword(event.target.value)}
                          autoComplete="new-password"
                          required
                        />
                        <button
                          type="button"
                          className="btn btn-icon password-toggle-button"
                          aria-label={showModeratorPassword ? "Hide password" : "Show password"}
                          aria-pressed={showModeratorPassword}
                          onClick={() => setShowModeratorPassword((current) => !current)}
                        >
                          <MaterialIcon name={showModeratorPassword ? "visibility_off" : "visibility"} />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="action-row">
                    <button type="submit" className="btn" disabled={moderatorSaving}>
                      <MaterialIcon name={moderatorSaving ? "hourglass_top" : "person_add"} />
                      <span>{moderatorSaving ? "Adding..." : "Add moderator"}</span>
                    </button>
                  </div>
                </div>
              </div>
            </form>

            {moderatorError ? <p className="error-text">{moderatorError}</p> : null}

            <div className="moderator-list">
              {moderators.length > 0 ? (
                moderators.map((moderator) => {
                  const isEditing = editingModeratorId === moderator.id;
                  const isBusy = moderatorActionId === moderator.id;

                  return (
                    <div className="moderator-item" key={moderator.id}>
                      {isEditing ? (
                        <form
                          className="moderator-edit-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleUpdateModerator(moderator);
                          }}
                        >
                          <div className="field-inline">
                            <label className="field-row" htmlFor={`moderator-edit-username-${moderator.id}`}>
                              <span className="field-label">Username</span>
                              <input
                                id={`moderator-edit-username-${moderator.id}`}
                                className="input"
                                value={editingModeratorUsername}
                                onChange={(event) => setEditingModeratorUsername(event.target.value)}
                                autoComplete="off"
                                required
                              />
                            </label>

                            <div className="field-row">
                              <label className="field-label" htmlFor={`moderator-edit-password-${moderator.id}`}>
                                New password
                              </label>
                              <div className="password-input-row">
                                <input
                                  id={`moderator-edit-password-${moderator.id}`}
                                  className="input"
                                  type={showEditingModeratorPassword ? "text" : "password"}
                                  value={editingModeratorPassword}
                                  onChange={(event) => setEditingModeratorPassword(event.target.value)}
                                  autoComplete="new-password"
                                  placeholder="Leave blank to keep"
                                />
                                <button
                                  type="button"
                                  className="btn btn-icon password-toggle-button"
                                  aria-label={showEditingModeratorPassword ? "Hide password" : "Show password"}
                                  aria-pressed={showEditingModeratorPassword}
                                  onClick={() => setShowEditingModeratorPassword((current) => !current)}
                                >
                                  <MaterialIcon name={showEditingModeratorPassword ? "visibility_off" : "visibility"} />
                                </button>
                              </div>
                            </div>
                          </div>

                          <div className="action-row">
                            <button type="submit" className="btn btn-primary" disabled={isBusy}>
                              <MaterialIcon name={isBusy ? "hourglass_top" : "save"} />
                              <span>{isBusy ? "Saving..." : "Save moderator"}</span>
                            </button>
                            <button type="button" className="btn btn-secondary" disabled={isBusy} onClick={resetModeratorEditor}>
                              <MaterialIcon name="close" />
                              <span>Cancel</span>
                            </button>
                          </div>
                        </form>
                      ) : (
                        <>
                          <div className="moderator-item-main">
                            <strong>{moderator.username}</strong>
                            <span>Updated {formatStatusTimestamp(moderator.updatedAt)}</span>
                          </div>

                          <div className="moderator-actions">
                            <span className="moderator-action-tooltip ui-tooltip" data-ui-tooltip="Edit">
                              <button
                                type="button"
                                className="btn btn-icon moderator-action-button"
                                aria-label="Edit"
                                disabled={Boolean(moderatorActionId)}
                                onClick={() => {
                                  setModeratorError(null);
                                  setEditingModeratorId(moderator.id);
                                  setEditingModeratorUsername(moderator.username);
                                  setEditingModeratorPassword("");
                                  setShowEditingModeratorPassword(false);
                                }}
                              >
                                <MaterialIcon name="edit" />
                              </button>
                            </span>
                            <span
                              className="moderator-action-tooltip ui-tooltip"
                              data-ui-tooltip="Remove"
                            >
                              <button
                                type="button"
                                className="btn btn-icon danger moderator-action-button"
                                aria-label="Remove"
                                disabled={Boolean(moderatorActionId)}
                                onClick={() => {
                                  if (window.confirm(`Remove moderator "${moderator.username}"?`)) {
                                    void handleDeleteModerator(moderator);
                                  }
                                }}
                              >
                                <MaterialIcon name={isBusy ? "hourglass_top" : "delete"} />
                              </button>
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="muted-caption">No moderator accounts yet.</p>
              )}
            </div>
          </section>

          <section className="panel-card panel-card-site">
            <div className="panel-header">
              <h2>Site Settings</h2>
            </div>

            <p className="panel-description">Configure site branding, footer text, start page behavior, and icon assets.</p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-inline">
                    <label className="field-row" htmlFor="site-title">
                      <span className="field-label">Site title</span>
                      <input
                        id="site-title"
                        className="input"
                        value={settings.siteTitle}
                        onChange={(event) => setSettings((prev) => ({ ...prev, siteTitle: event.target.value }))}
                        required
                      />
                      <span className="field-hint">Shown in the header and browser metadata.</span>
                    </label>

                    <label className="field-row" htmlFor="site-description">
                      <span className="field-label">Site description</span>
                      <input
                        id="site-description"
                        className="input"
                        value={settings.siteDescription}
                        onChange={(event) => setSettings((prev) => ({ ...prev, siteDescription: event.target.value }))}
                        required
                      />
                      <span className="field-hint">Short summary used in metadata and previews.</span>
                    </label>
                  </div>

                  <label className="field-row" htmlFor="site-footer-text">
                    <span className="field-label">
                      Footer Text
                    </span>
                    <input
                      id="site-footer-text"
                      className="input"
                      value={settings.footerText}
                      onChange={(event) => setSettings((prev) => ({ ...prev, footerText: event.target.value }))}
                      placeholder={DEFAULT_FOOTER_TEXT}
                      required
                    />
                    <span className="field-hint">
                      <code>{`{{year}}`}</code>, <code>{`{{owner}}`}</code>, and <code>{`{{vicky}}`}</code> are replaced
                      automatically. <code>{`{{vicky}}`}</code> becomes a clickable link to the Vicky repository.
                    </span>
                  </label>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-inline">
                    <ColorPickerField
                      id="site-title-gradient-from"
                      label="Site title gradient from (optional)"
                      value={settings.siteTitleGradientFrom}
                      allowEmpty
                      fallbackColor={DEFAULT_SITE_TITLE_GRADIENT_FROM}
                      hint="Pick the start color for the site title gradient. Clear both gradient colors to disable it."
                      onChange={(value) => setSettings((prev) => ({ ...prev, siteTitleGradientFrom: value }))}
                    />

                    <ColorPickerField
                      id="site-title-gradient-to"
                      label="Site title gradient to (optional)"
                      value={settings.siteTitleGradientTo}
                      allowEmpty
                      fallbackColor={DEFAULT_SITE_TITLE_GRADIENT_TO}
                      hint="Pick the end color for the site title gradient. Clear both gradient colors to disable it."
                      onChange={(value) => setSettings((prev) => ({ ...prev, siteTitleGradientTo: value }))}
                    />
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <label className="field-row" htmlFor="site-start-page">
                    <span className="field-label">Start page (docs path)</span>
                    <input
                      id="site-start-page"
                      className="input"
                      value={settings.startPage}
                      onChange={(event) => setSettings((prev) => ({ ...prev, startPage: event.target.value }))}
                      placeholder="/home"
                      required
                    />
                    <span className="field-hint">
                      Preferred format: <code>/home</code>. <code>/docs/home</code> and full docs URLs are normalized
                      automatically.
                    </span>
                  </label>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-inline">
                    <label className="field-row" htmlFor="docs-icon-png-16">
                      <span className="field-label">Docs icon 16x16 PNG URL</span>
                      <input
                        id="docs-icon-png-16"
                        className="input"
                        value={settings.docsIconPng16Url}
                        onChange={(event) => setSettings((prev) => ({ ...prev, docsIconPng16Url: event.target.value }))}
                        placeholder="https://example.com/docs-icon-16.png"
                      />
                      <span className="field-hint">Public absolute URL to a PNG file, exactly 16x16 recommended.</span>
                    </label>

                    <label className="field-row" htmlFor="docs-icon-png-32">
                      <span className="field-label">Docs icon 32x32 PNG URL</span>
                      <input
                        id="docs-icon-png-32"
                        className="input"
                        value={settings.docsIconPng32Url}
                        onChange={(event) => setSettings((prev) => ({ ...prev, docsIconPng32Url: event.target.value }))}
                        placeholder="https://example.com/docs-icon-32.png"
                      />
                      <span className="field-hint">Public absolute URL to a PNG file, exactly 32x32 recommended.</span>
                    </label>
                  </div>

                  <label className="field-row" htmlFor="docs-icon-png-180">
                    <span className="field-label">Docs icon 180x180 PNG URL</span>
                    <input
                      id="docs-icon-png-180"
                      className="input"
                      value={settings.docsIconPng180Url}
                      onChange={(event) => setSettings((prev) => ({ ...prev, docsIconPng180Url: event.target.value }))}
                      placeholder="https://example.com/docs-icon-180.png"
                    />
                    <span className="field-hint">
                      Public absolute URL to a PNG file, exactly 180x180 recommended (Apple touch icon).
                    </span>
                  </label>
                </div>
              </div>

            </div>
          </section>

          <section className="panel-card panel-card-domain">
            <div className="panel-header">
              <h2>Domain Settings</h2>
            </div>

            <p className="panel-description">
              Configure your custom domain and Let&apos;s Encrypt contact email for automatic HTTPS certificate management.
            </p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <label className="field-row" htmlFor="domain-custom-domain">
                    <span className="field-label">Custom domain</span>
                    <input
                      id="domain-custom-domain"
                      className="input"
                      value={settings.customDomain}
                      aria-invalid={Boolean(domainFieldErrors.customDomain)}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSettings((prev) => ({ ...prev, customDomain: value }));
                        setDomainFieldErrors((prev) => ({
                          ...prev,
                          customDomain: validateCustomDomainInput(value),
                        }));
                      }}
                      placeholder="docs.example.com"
                    />
                    <span className="field-hint">
                      Hostname only (no protocol or path). Example: <code>example.com</code> or{" "}
                      <code>docs.example.com</code>.
                    </span>
                    {domainFieldErrors.customDomain ? <span className="error-text">{domainFieldErrors.customDomain}</span> : null}
                  </label>

                  <label className="field-row" htmlFor="domain-letsencrypt-email">
                    <span className="field-label">Let&apos;s Encrypt email</span>
                    <input
                      id="domain-letsencrypt-email"
                      className="input"
                      type="email"
                      value={settings.letsEncryptEmail}
                      aria-invalid={Boolean(domainFieldErrors.letsEncryptEmail)}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSettings((prev) => ({ ...prev, letsEncryptEmail: value }));
                        setDomainFieldErrors((prev) => ({
                          ...prev,
                          letsEncryptEmail: validateLetsEncryptEmailInput(value),
                        }));
                      }}
                      placeholder="admin@example.com"
                    />
                    <span className="field-hint">
                      Required for automatic certificate registration and renewal notifications.
                    </span>
                    {domainFieldErrors.letsEncryptEmail ? (
                      <span className="error-text">{domainFieldErrors.letsEncryptEmail}</span>
                    ) : null}
                  </label>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <span className="field-label">SSL runtime status</span>
                    {sslStatusLoading ? <span className="field-hint">Checking certificate runtime status...</span> : null}
                    {!sslStatusLoading && sslStatus ? (
                      <>
                        <p className={statusToneClassName(sslStatus)}>{sslStatus.message}</p>
                        <span className="field-hint">
                          Source:{" "}
                          {sslStatus.source === "runtime"
                            ? "private runtime status snapshot."
                            : "best-effort check (settings + local cert files)."}
                        </span>
                        {sslStatus.certificateExpiresAt ? (
                          <span className="field-hint">
                            Certificate expiry: {formatStatusTimestamp(sslStatus.certificateExpiresAt)}.
                          </span>
                        ) : null}
                        <span className="field-hint">
                          Custom-domain HTTP policy: {formatCustomDomainHttpPolicy(sslStatus)}.
                        </span>
                        <span className="field-hint">Last checked: {formatStatusTimestamp(sslStatus.checkedAt)}.</span>
                      </>
                    ) : null}
                    {sslStatusError ? <p className="warning-text">Could not load SSL runtime status: {sslStatusError}</p> : null}
                  </div>

                  <p className="warning-text">
                    Automatic SSL runs only when both values are set and DNS points this domain to your server.
                  </p>
                </div>
              </div>

            </div>
          </section>

          <section className="panel-card panel-card-ai-chat">
            <div className="panel-header">
              <h2>AI Chat</h2>
            </div>

            <p className="panel-description">
              Configure the AI chat assistant shown in docs pages.
            </p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <span className="field-label">Enable AI chat</span>
                    <EnabledToggle
                      id="ai-chat-enabled"
                      checked={settings.aiChatEnabled}
                      onChange={(enabled) => setSettings((prev) => ({ ...prev, aiChatEnabled: enabled }))}
                    />
                    <span className="field-hint">
                      Shows the floating Ask Docs button on docs pages and enables the public chat API route.
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="ai-chat-assistant-name">
                      Assistant name
                    </label>
                    <div className="field-control-row">
                      <input
                        id="ai-chat-assistant-name"
                        className="input"
                        value={settings.aiChatAssistantName}
                        onChange={(event) => setSettings((prev) => ({ ...prev, aiChatAssistantName: event.target.value }))}
                        placeholder={DEFAULT_AI_CHAT_ASSISTANT_NAME}
                      />
                      <ResetToDefaultButton
                        disabled={settings.aiChatAssistantName === DEFAULT_AI_CHAT_ASSISTANT_NAME}
                        onClick={() =>
                          setSettings((prev) => ({ ...prev, aiChatAssistantName: DEFAULT_AI_CHAT_ASSISTANT_NAME }))
                        }
                      />
                    </div>
                    <span className="field-hint">
                      Shown in the chat header, welcome message, and reply labels. Use{" "}
                      <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> in the system prompt to reference this value dynamically.
                    </span>
                  </div>

                  <label className="field-row" htmlFor="ai-chat-avatar-url">
                    <span className="field-label">Assistant profile image URL</span>
                    <input
                      id="ai-chat-avatar-url"
                      className="input"
                      value={settings.aiChatAvatarUrl}
                      onChange={(event) => setSettings((prev) => ({ ...prev, aiChatAvatarUrl: event.target.value }))}
                      placeholder="https://example.com/assistant-avatar.png"
                    />
                    <span className="field-hint">
                      Optional image shown in the top-left chat header badge. Leave blank to use the default assistant icon.
                    </span>
                  </label>

                  <div className="field-row">
                    <label className="field-label" htmlFor="ai-chat-header-subtitle">
                      Header subtitle
                    </label>
                    <div className="field-control-row">
                      <input
                        id="ai-chat-header-subtitle"
                        className="input"
                        value={settings.aiChatHeaderSubtitle}
                        onChange={(event) => setSettings((prev) => ({ ...prev, aiChatHeaderSubtitle: event.target.value }))}
                        placeholder={DEFAULT_AI_CHAT_HEADER_SUBTITLE}
                      />
                      <ResetToDefaultButton
                        disabled={settings.aiChatHeaderSubtitle === DEFAULT_AI_CHAT_HEADER_SUBTITLE}
                        onClick={() =>
                          setSettings((prev) => ({ ...prev, aiChatHeaderSubtitle: DEFAULT_AI_CHAT_HEADER_SUBTITLE }))
                        }
                      />
                    </div>
                    <span className="field-hint">
                      Shown below the assistant name in the chat header. Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> if
                      you want the configured assistant name inserted automatically.
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="ai-chat-welcome-message">
                      Welcome message
                    </label>
                    <div className="field-control-stack">
                      <textarea
                        id="ai-chat-welcome-message"
                        className="input textarea"
                        rows={4}
                        value={settings.aiChatWelcomeMessage}
                        onChange={(event) => setSettings((prev) => ({ ...prev, aiChatWelcomeMessage: event.target.value }))}
                        placeholder={DEFAULT_AI_CHAT_WELCOME_MESSAGE}
                      />
                      <ResetToDefaultButton
                        disabled={settings.aiChatWelcomeMessage === DEFAULT_AI_CHAT_WELCOME_MESSAGE}
                        onClick={() =>
                          setSettings((prev) => ({ ...prev, aiChatWelcomeMessage: DEFAULT_AI_CHAT_WELCOME_MESSAGE }))
                        }
                      />
                    </div>
                    <span className="field-hint">
                      Shown as the first assistant message in new chats. Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> if
                      you want the configured assistant name inserted automatically.
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="openrouter-model">
                      OpenRouter model
                    </label>
                    <div className="field-control-row">
                      <input
                        id="openrouter-model"
                        className="input"
                        value={settings.openRouterModel}
                        aria-invalid={Boolean(aiChatFieldErrors.openRouterModel)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, openRouterModel: value }));
                          setAiChatFieldErrors((prev) => ({
                            ...prev,
                            openRouterModel: validateOpenRouterModelInput(value, settings.aiChatEnabled),
                          }));
                        }}
                        placeholder={DEFAULT_AI_CHAT_OPENROUTER_MODEL}
                      />
                      <ResetToDefaultButton
                        disabled={settings.openRouterModel === DEFAULT_AI_CHAT_OPENROUTER_MODEL}
                        onClick={() => {
                          setSettings((prev) => ({ ...prev, openRouterModel: DEFAULT_AI_CHAT_OPENROUTER_MODEL }));
                          setAiChatFieldErrors((prev) => ({ ...prev, openRouterModel: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Example: <code>openai/gpt-5.4-mini</code>. Use a vision-capable model if you want image uploads.
                    </span>
                    {aiChatFieldErrors.openRouterModel ? <span className="error-text">{aiChatFieldErrors.openRouterModel}</span> : null}
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="ai-chat-system-prompt">
                      System prompt template
                    </label>
                    <div className="field-control-stack">
                      <textarea
                        id="ai-chat-system-prompt"
                        className="input textarea"
                        rows={10}
                        value={settings.aiChatSystemPrompt}
                        aria-invalid={Boolean(aiChatFieldErrors.systemPrompt)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, aiChatSystemPrompt: value }));
                          setAiChatFieldErrors((prev) => ({
                            ...prev,
                            systemPrompt: validateSystemPromptInput(value, settings.aiChatEnabled),
                          }));
                        }}
                        placeholder={DEFAULT_AI_CHAT_SYSTEM_PROMPT}
                      />
                      <ResetToDefaultButton
                        disabled={settings.aiChatSystemPrompt === DEFAULT_AI_CHAT_SYSTEM_PROMPT}
                        onClick={() => {
                          setSettings((prev) => ({ ...prev, aiChatSystemPrompt: DEFAULT_AI_CHAT_SYSTEM_PROMPT }));
                          setAiChatFieldErrors((prev) => ({ ...prev, systemPrompt: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Use <code>{AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}</code> for the configured assistant name and keep{" "}
                      <code>{AI_CHAT_DOCS_PLACEHOLDER}</code> exactly where the live <code>/docs.txt</code> export should be injected.
                    </span>
                    {aiChatFieldErrors.systemPrompt ? <span className="error-text">{aiChatFieldErrors.systemPrompt}</span> : null}
                  </div>
                </div>
              </div>

            </div>
          </section>
        </div>

        <div className="panel-stack-right">
          <VisitorStatsCard />

          <section className="panel-card panel-card-theme">
            <div className="panel-header">
              <h2>Theme Management</h2>
            </div>

            <p className="panel-description">Customize the Light and Dark mode emphasis and interface accent colors.</p>

            <div className="theme-editor">
              <div className="theme-color-grid">
                <div className="theme-color-section">
                  <strong className="theme-color-section-title">Light mode</strong>
                  <div className="theme-accent-fields">
                    <ColorPickerField
                      id="theme-light-surface-accent"
                      label="Interface accent"
                      value={settings.themeLightSurfaceAccent}
                      fallbackColor={THEME_DEFAULTS.lightSurfaceAccent}
                      showReset
                      hint="Used for default buttons, controls, subtle hover states, panels, page headers, and navigation surfaces in Light mode."
                      onChange={(value) => setSettings((prev) => ({ ...prev, themeLightSurfaceAccent: value }))}
                    />
                    <ColorPickerField
                      id="theme-light-accent"
                      label="Emphasis accent"
                      value={settings.themeLightAccent}
                      fallbackColor={THEME_DEFAULTS.lightAccent}
                      showReset
                      hint="Used for links, primary actions, active states, focus borders, and strong highlights in Light mode."
                      onChange={(value) => setSettings((prev) => ({ ...prev, themeLightAccent: value }))}
                    />
                  </div>
                </div>

                <div className="theme-color-section">
                  <strong className="theme-color-section-title">Dark mode</strong>
                  <div className="theme-accent-fields">
                    <ColorPickerField
                      id="theme-dark-surface-accent"
                      label="Interface accent"
                      value={settings.themeDarkSurfaceAccent}
                      fallbackColor={THEME_DEFAULTS.darkSurfaceAccent}
                      showReset
                      hint="Used for default buttons, controls, subtle hover states, panels, page headers, and navigation surfaces in Dark mode."
                      onChange={(value) => setSettings((prev) => ({ ...prev, themeDarkSurfaceAccent: value }))}
                    />
                    <ColorPickerField
                      id="theme-dark-accent"
                      label="Emphasis accent"
                      value={settings.themeDarkAccent}
                      fallbackColor={THEME_DEFAULTS.darkAccent}
                      showReset
                      hint="Used for links, primary actions, active states, focus borders, and strong highlights in Dark mode."
                      onChange={(value) => setSettings((prev) => ({ ...prev, themeDarkAccent: value }))}
                    />
                  </div>
                </div>
              </div>

              <div className="theme-preview-grid">
                <div className="theme-preview-card" style={lightPreviewStyle}>
                  <div className="theme-preview-header">
                    <strong>Light mode</strong>
                    <span className="theme-preview-chip">Preview</span>
                  </div>
                  <p className="theme-preview-copy">
                    Emphasis accent drives links, primary actions, active states, and strong highlights. Interface accent drives controls and navigation surfaces.
                  </p>
                  <div className="theme-preview-actions">
                    <span className="theme-preview-link">Example link</span>
                    <span className="theme-preview-surface-chip">Interface control</span>
                    <button type="button" className="theme-preview-button">
                      Emphasis action
                    </button>
                  </div>
                </div>

                <div className="theme-preview-card" style={darkPreviewStyle}>
                  <div className="theme-preview-header">
                    <strong>Dark mode</strong>
                    <span className="theme-preview-chip">Preview</span>
                  </div>
                  <p className="theme-preview-copy">
                    Emphasis accent drives links, primary actions, active states, and strong highlights. Interface accent drives controls and navigation surfaces.
                  </p>
                  <div className="theme-preview-actions">
                    <span className="theme-preview-link">Example link</span>
                    <span className="theme-preview-surface-chip">Interface control</span>
                    <button type="button" className="theme-preview-button">
                      Emphasis action
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <label className="field-row" htmlFor="theme-custom-css">
                    <span className="field-label">Custom CSS</span>
                    <textarea
                      id="theme-custom-css"
                      className="input textarea"
                      rows={6}
                      value={settings.themeCustomCss}
                      onChange={(event) => setSettings((prev) => ({ ...prev, themeCustomCss: event.target.value }))}
                      placeholder=".markdown-body a { text-decoration-thickness: 2px; }"
                    />
                    <span className="field-hint">
                      Optional advanced overrides applied on top of the built-in Light and Dark themes.
                    </span>
                  </label>
                </div>
              </div>

            </div>
          </section>

          <section className="panel-card panel-card-openrouter">
            <div className="panel-header">
              <h2>OpenRouter Settings</h2>
            </div>

            <p className="panel-description">
              Shared OpenRouter credentials for AI-powered docs features.
            </p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="openrouter-api-key">
                      OpenRouter API key
                    </label>
                    <div className="secret-input-row">
                      <input
                        id="openrouter-api-key"
                        className="input"
                        type="text"
                        autoComplete="off"
                        value={settings.openRouterApiKey}
                        aria-invalid={Boolean(openRouterFieldErrors.apiKey)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, openRouterApiKey: value }));
                          setOpenRouterFieldErrors((prev) => ({
                            ...prev,
                            apiKey: validateOpenRouterApiKeyInput(
                              value,
                              settings.openRouterApiKeyConfigured,
                              settings.aiChatEnabled || settings.autoTranslateEnabled,
                            ),
                          }));
                        }}
                        placeholder={
                          settings.openRouterApiKeyConfigured
                            ? "Saved OpenRouter key configured (leave blank to keep)"
                            : "sk-or-v1-..."
                        }
                      />
                      <button
                        type="button"
                        className="btn secret-clear-button"
                        disabled={
                          settingsSaving ||
                          clearingSecret !== null ||
                          (!settings.openRouterApiKey.trim() && !settings.openRouterApiKeyConfigured)
                        }
                        onClick={() => {
                          void clearSavedSecret("openRouterApiKey");
                        }}
                      >
                        {clearingSecret === "openRouterApiKey" ? "Clearing..." : "Clear"}
                      </button>
                    </div>
                    <span className="field-hint">
                      Stored encrypted in the local app settings file. Leave blank to keep the existing saved key.
                    </span>
                    {openRouterFieldErrors.apiKey ? <span className="error-text">{openRouterFieldErrors.apiKey}</span> : null}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="panel-card panel-card-auto-translate">
            <div className="panel-header">
              <h2>Page Localization</h2>
            </div>

            <p className="panel-description">
              Serve manually maintained GitHub localization files and optionally update outdated translations with OpenRouter.
            </p>

            <div className="form-grid">
              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <span className="field-label">Automatic translation updates</span>
                    <EnabledToggle
                      id="auto-translate-enabled"
                      checked={settings.autoTranslateEnabled}
                      onChange={(enabled) => {
                        setSettings((prev) => ({ ...prev, autoTranslateEnabled: enabled }));
                        setOpenRouterFieldErrors((prev) => ({
                          ...prev,
                          apiKey: validateOpenRouterApiKeyInput(
                            settings.openRouterApiKey,
                            settings.openRouterApiKeyConfigured,
                            enabled || settings.aiChatEnabled,
                          ),
                        }));
                      }}
                    />
                    <span className="field-hint">
                      When enabled, requested outdated existing localization files are updated automatically. Missing files are only created by admin actions.
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-subcard">
                <div className="settings-subcard-fields">
                  <div className="field-row">
                    <label className="field-label" htmlFor="auto-translate-localization-path">
                      Localization directory
                    </label>
                    <div className="field-control-row">
                      <input
                        id="auto-translate-localization-path"
                        className="input"
                        value={settings.autoTranslateLocalizationPath}
                        aria-invalid={Boolean(autoTranslateFieldErrors.localizationPath)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, autoTranslateLocalizationPath: value }));
                          setAutoTranslateFieldErrors((prev) => ({
                            ...prev,
                            localizationPath: validateLocalizationPathInput(value),
                          }));
                        }}
                        onBlur={(event) => {
                          const normalized = normalizeLocalizationPath(event.target.value);
                          setSettings((prev) => ({ ...prev, autoTranslateLocalizationPath: normalized }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, localizationPath: null }));
                        }}
                        placeholder={DEFAULT_LOCALIZATION_PATH}
                      />
                      <ResetToDefaultButton
                        disabled={settings.autoTranslateLocalizationPath === DEFAULT_LOCALIZATION_PATH}
                        onClick={() => {
                          setSettings((prev) => ({
                            ...prev,
                            autoTranslateLocalizationPath: DEFAULT_LOCALIZATION_PATH,
                          }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, localizationPath: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Repo-root directory. Files live at <code>{settings.autoTranslateLocalizationPath || DEFAULT_LOCALIZATION_PATH}/&lt;lang&gt;/page.md</code>.
                    </span>
                    {autoTranslateFieldErrors.localizationPath ? (
                      <span className="error-text">{autoTranslateFieldErrors.localizationPath}</span>
                    ) : null}
                  </div>

                  <div className="field-row">
                    <label className="field-label" htmlFor="auto-translate-openrouter-model">
                      Translation model
                    </label>
                    <div className="field-control-row">
                      <input
                        id="auto-translate-openrouter-model"
                        className="input"
                        value={settings.autoTranslateOpenRouterModel}
                        aria-invalid={Boolean(autoTranslateFieldErrors.openRouterModel)}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSettings((prev) => ({ ...prev, autoTranslateOpenRouterModel: value }));
                          setAutoTranslateFieldErrors((prev) => ({
                            ...prev,
                            openRouterModel: validateOpenRouterModelInput(value, settings.autoTranslateEnabled),
                          }));
                        }}
                        placeholder={DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL}
                      />
                      <ResetToDefaultButton
                        disabled={settings.autoTranslateOpenRouterModel === DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL}
                        onClick={() => {
                          setSettings((prev) => ({
                            ...prev,
                            autoTranslateOpenRouterModel: DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
                          }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, openRouterModel: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Default: <code>{DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL}</code>.
                    </span>
                    {autoTranslateFieldErrors.openRouterModel ? (
                      <span className="error-text">{autoTranslateFieldErrors.openRouterModel}</span>
                    ) : null}
                  </div>

                  <div className="field-row">
                    <label className="field-label" htmlFor="auto-translate-request-timeout">
                      Request timeout
                    </label>
                    <div className="field-control-row">
                      <input
                        id="auto-translate-request-timeout"
                        className="input"
                        type="number"
                        min={MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000}
                        step={1}
                        value={settings.autoTranslateRequestTimeoutSeconds}
                        aria-invalid={Boolean(autoTranslateFieldErrors.requestTimeout)}
                        onChange={(event) => {
                          const rawValue = Number(event.target.value);
                          const value = Number.isFinite(rawValue)
                            ? rawValue
                            : MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000;
                          setSettings((prev) => ({ ...prev, autoTranslateRequestTimeoutSeconds: value }));
                          setAutoTranslateFieldErrors((prev) => ({
                            ...prev,
                            requestTimeout: validateAutoTranslateRequestTimeoutSeconds(value),
                          }));
                        }}
                        onBlur={(event) => {
                          const normalized = normalizeAutoTranslateRequestTimeoutSeconds(
                            Number(event.currentTarget.value),
                          );
                          setSettings((prev) => ({ ...prev, autoTranslateRequestTimeoutSeconds: normalized }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, requestTimeout: null }));
                        }}
                      />
                      <ResetToDefaultButton
                        disabled={
                          settings.autoTranslateRequestTimeoutSeconds ===
                          DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000
                        }
                        onClick={() => {
                          setSettings((prev) => ({
                            ...prev,
                            autoTranslateRequestTimeoutSeconds: DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000,
                          }));
                          setAutoTranslateFieldErrors((prev) => ({ ...prev, requestTimeout: null }));
                        }}
                      />
                    </div>
                    <span className="field-hint">
                      Seconds per OpenRouter translation request. Default:{" "}
                      <code>{DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000}</code>.
                    </span>
                    {autoTranslateFieldErrors.requestTimeout ? (
                      <span className="error-text">{autoTranslateFieldErrors.requestTimeout}</span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="field-row">
                <span className="field-label">Selectable languages</span>
                <div className="action-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={activeTranslationMode !== null}
                    onClick={() => {
                      void requestBulkTranslations("outdated");
                    }}
                  >
                    <MaterialIcon name={activeTranslationMode === "outdated" ? "hourglass_top" : "sync"} />
                    <span>{activeTranslationMode === "outdated" ? "Updating..." : "Update All Outdated"}</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={activeTranslationMode !== null}
                    onClick={() => {
                      void requestBulkTranslations("missing-and-outdated");
                    }}
                  >
                    <MaterialIcon name={activeTranslationMode === "missing-and-outdated" ? "hourglass_top" : "translate"} />
                    <span>
                      {activeTranslationMode === "missing-and-outdated" ? "Translating..." : "Translate All Missing/Outdated"}
                    </span>
                  </button>

                  {unrecordedTranslationCount > 0 || activeTranslationMode === "source-versions" ? (
                    <button
                      type="button"
                      className="btn btn-secondary translation-record-source-versions"
                      disabled={activeTranslationMode !== null}
                      onClick={() => {
                        void recordSourceVersions();
                      }}
                    >
                      <MaterialIcon name={activeTranslationMode === "source-versions" ? "hourglass_top" : "fact_check"} />
                      <span>{activeTranslationMode === "source-versions" ? "Recording..." : "Record Source Versions"}</span>
                    </button>
                  ) : null}
                </div>
                {unrecordedTranslationCount > 0 && activeTranslationMode !== "source-versions" ? (
                  <span className="field-hint">
                    {formatCount(unrecordedTranslationCount)} current translation{unrecordedTranslationCount === 1 ? " doesn't" : "s don't"} say
                    which version of {unrecordedTranslationCount === 1 ? "its" : "their"} page {unrecordedTranslationCount === 1 ? "it was" : "they were"} translated from yet.
                    Record it once and outdated checks become exact. Outdated translations get it the next time they&apos;re translated.
                  </span>
                ) : null}
                <div className="translation-language-list">
                  <div className="translation-language-item translation-language-label-row" aria-hidden="true">
                    <div className="field-inline translation-language-fields translation-language-label-fields">
                      <span className="field-label">Visible</span>
                      <span className="field-label">Display name</span>
                      <span className="field-label">ID</span>
                      <span className="field-label">Icon</span>
                    </div>
                    <div className="translation-language-label-actions" />
                  </div>
                  {settings.autoTranslateLanguages.map((language, index) => {
                    const isDefaultLanguage = isDefaultAutoTranslateLanguageCode(language.code);
                    const languageEnabled = isDefaultLanguage || language.enabled !== false;
                    const normalizedLanguageCode = normalizeAutoTranslateLanguageCode(language.code);
                    const languageIcon = isDefaultLanguage
                      ? getDefaultAutoTranslateLanguageIcon(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE)
                      : normalizeCircleFlagIconId(language.icon) ||
                        getDefaultAutoTranslateLanguageIcon(normalizedLanguageCode || language.code);
                    const translationRequestDisabled =
                      isDefaultLanguage ||
                      activeTranslationMode !== null ||
                      (normalizedLanguageCode
                        ? requestedTranslationLanguageCodes.has(normalizedLanguageCode.toLowerCase())
                        : false);
                    const translationCacheStatus =
                      normalizedLanguageCode && translationStatusesLocalizationPath === normalizeLocalizationPath(settings.autoTranslateLocalizationPath)
                        ? translationCacheStatuses[translationCacheStatusKey(normalizedLanguageCode)]
                        : undefined;
                    const translationStatusProgress =
                      translationCacheStatus && isTranslationStatusPending(translationCacheStatus) ? getTranslationStatusProgressPercent(translationCacheStatus) : null;
                    const translationCacheStatusTone = getTranslationCacheStatusTone(translationCacheStatus);
                    const translationCacheStatusLabel = getTranslationCacheStatusLabel(translationCacheStatus);
                    const translationCacheStatusTooltip =
                      !translationCacheStatus && translationCacheStatusError
                        ? translationCacheStatusError
                        : !translationCacheStatus && translationCacheStatusLoading
                          ? "Checking localization status"
                        : getTranslationCacheStatusTooltip(translationCacheStatus);
                    const languageKey = `${language.code || "language"}-${index}`;

                    return (
                      <div
                        className={`translation-language-item${isDefaultLanguage ? " translation-language-item-fixed" : ""}`}
                        key={languageKey}
                      >
                        <div className="field-inline translation-language-fields">
                          <label
                            className={`toggle-row translation-language-visibility-toggle${
                              isDefaultLanguage ? " translation-language-visibility-toggle-disabled" : ""
                            } ui-tooltip`}
                            data-ui-tooltip={isDefaultLanguage ? "Source language is always visible" : languageEnabled ? "Visible to visitors" : "Hidden from visitors"}
                            htmlFor={`auto-translate-language-enabled-${index}`}
                          >
                            <input
                              id={`auto-translate-language-enabled-${index}`}
                              className="toggle-input"
                              type="checkbox"
                              checked={languageEnabled}
                              disabled={isDefaultLanguage}
                              aria-label={`${languageEnabled ? "Hide" : "Show"} ${isDefaultLanguage ? DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME : language.name || "language"} in the public language selector`}
                              onChange={(event) => {
                                const nextEnabled = event.target.checked;
                                const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, enabled: nextEnabled } : entry,
                                );
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                            />
                            <span className="toggle-control" aria-hidden="true">
                              <span className="toggle-thumb" />
                            </span>
                          </label>

                          <label
                            className="field-row translation-language-name-field"
                            htmlFor={`auto-translate-language-name-${index}`}
                          >
                            <input
                              id={`auto-translate-language-name-${index}`}
                              className="input"
                              aria-label="Display name"
                              value={isDefaultLanguage ? DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME : language.name}
                              disabled={isDefaultLanguage}
                              onChange={(event) => {
                                const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, name: event.target.value } : entry,
                                );
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                            />
                          </label>

                          <label
                            className="field-row translation-language-code-field"
                            htmlFor={`auto-translate-language-code-${index}`}
                          >
                            <input
                              id={`auto-translate-language-code-${index}`}
                              className="input"
                              aria-label="ID"
                              value={isDefaultLanguage ? DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE : language.code}
                              disabled={isDefaultLanguage}
                              onChange={(event) => {
                                const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, code: event.target.value } : entry,
                                );
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                              onBlur={(event) => {
                                const normalizedCode = normalizeAutoTranslateLanguageCode(event.target.value);
                                if (!normalizedCode) {
                                  return;
                                }

                                const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                  entryIndex === index ? { ...entry, code: normalizedCode } : entry,
                                );
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                            />
                          </label>

                          <CircleFlagIconPicker
                            id={`auto-translate-language-icon-${index}`}
                            value={languageIcon}
                            disabled={isDefaultLanguage}
                            selectedDisplay="icon"
                            showLabel={false}
                            onChange={(icon) => {
                              const nextLanguages = settings.autoTranslateLanguages.map((entry, entryIndex) =>
                                entryIndex === index ? { ...entry, icon } : entry,
                              );
                              setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                              setAutoTranslateFieldErrors((prev) => ({
                                ...prev,
                                languages: validateAutoTranslateLanguages(nextLanguages),
                              }));
                            }}
                          />
                        </div>

                        <div className="translation-language-actions">
                          <span
                            className={`translation-language-cache-status translation-language-cache-status-${translationCacheStatusTone}${
                              translationStatusProgress === null ? "" : " translation-language-cache-status-progress"
                            } ui-tooltip`}
                            data-ui-tooltip={translationCacheStatusTooltip}
                            aria-label={translationCacheStatusTooltip}
                            {...(translationStatusProgress === null
                              ? {}
                              : {
                                  role: "progressbar",
                                  "aria-valuemin": 0,
                                  "aria-valuemax": 100,
                                  "aria-valuenow": translationStatusProgress,
                                  style: { "--translation-status-progress": translationStatusProgress / 100 } as CSSProperties,
                                })}
                          >
                            {translationCacheStatusLabel}
                          </span>
                          <span
                            className="translation-language-action-tooltip ui-tooltip"
                            data-ui-tooltip="Request Translations for All Pages"
                          >
                            <button
                              type="button"
                              className="btn btn-icon translation-language-request"
                              aria-label="Request Translations for All Pages"
                              disabled={translationRequestDisabled}
                              onClick={() => {
                                void requestLanguageTranslations(language);
                              }}
                            >
                              <MaterialIcon name="download" />
                            </button>
                          </span>
                          <span
                            className="translation-language-action-tooltip ui-tooltip"
                            data-ui-tooltip="Remove"
                          >
                            <button
                              type="button"
                              className="btn btn-icon danger translation-language-remove"
                              aria-label="Remove"
                              disabled={isDefaultLanguage}
                              onClick={() => {
                                const nextLanguages = settings.autoTranslateLanguages.filter((_, entryIndex) => entryIndex !== index);
                                setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                                setAutoTranslateFieldErrors((prev) => ({
                                  ...prev,
                                  languages: validateAutoTranslateLanguages(nextLanguages),
                                }));
                              }}
                            >
                              <MaterialIcon name={isDefaultLanguage ? "lock" : "delete"} />
                            </button>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="action-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      const nextLanguages = [
                        ...settings.autoTranslateLanguages,
                        createCustomAutoTranslateLanguage(settings.autoTranslateLanguages),
                      ];
                      setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                      setAutoTranslateFieldErrors((prev) => ({
                        ...prev,
                        languages: validateAutoTranslateLanguages(nextLanguages),
                      }));
                    }}
                  >
                    <MaterialIcon name="add" />
                    <span>Add language</span>
                  </button>

                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={
                      JSON.stringify(settings.autoTranslateLanguages) ===
                      JSON.stringify(DEFAULT_AUTO_TRANSLATE_LANGUAGES)
                    }
                    onClick={() => {
                      const nextLanguages = DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language }));
                      setSettings((prev) => ({ ...prev, autoTranslateLanguages: nextLanguages }));
                      setAutoTranslateFieldErrors((prev) => ({
                        ...prev,
                        languages: validateAutoTranslateLanguages(nextLanguages),
                      }));
                    }}
                  >
                    Reset languages
                  </button>
                </div>

                <div className="translation-log-panel">
                  <div className="translation-log-header">
                    <span className="field-label">Translation log</span>
                    <span
                      className={`translation-language-cache-status translation-language-cache-status-${getTranslationJobStatusTone(
                        translationJob,
                      )}`}
                    >
                      {getTranslationJobStatusLabel(translationJob)}
                    </span>
                  </div>

                  {translationJob?.mode === "source-versions" ? (
                    <div className="translation-log-summary">
                      <span>
                        {translationJob.result.uploadedPages}/{translationJob.result.requestedPages} recorded
                      </span>
                      <span>{translationJob.result.failedPages} failed</span>
                    </div>
                  ) : translationJob ? (
                    <div className="translation-log-summary">
                      <span>
                        {translationJob.result.translatedPages}/{translationJob.result.requestedPages} translated
                      </span>
                      <span>{translationJob.result.uploadedPages} uploaded</span>
                      <span>{translationJob.result.cachedPages} current</span>
                      <span>{translationJob.result.failedPages} failed</span>
                    </div>
                  ) : null}

                  <div className="translation-log-scroll" ref={translationLogRef} aria-live="polite">
                    {translationRequestStatus ? (
                      <div className={`translation-log-entry translation-log-entry-${translationRequestStatus.tone}`}>
                        <MaterialIcon name={translationRequestStatus.tone === "error" ? "error" : "warning"} />
                        <div className="translation-log-entry-body">
                          <span className="translation-log-entry-message">{translationRequestStatus.message}</span>
                        </div>
                      </div>
                    ) : null}
                    {translationLogEntries.length > 0 ? (
                      translationLogEntries.map((entry) => (
                        <div className={`translation-log-entry translation-log-entry-${entry.level}`} key={entry.id}>
                          <MaterialIcon name={getTranslationLogIcon(entry.level)} />
                          <div className="translation-log-entry-body">
                            <span className="translation-log-entry-time">{formatStatusTimestamp(entry.createdAt)}</span>
                            <span className="translation-log-entry-message">{entry.message}</span>
                            {entry.details ? <span className="translation-log-entry-details">{entry.details}</span> : null}
                          </div>
                        </div>
                      ))
                    ) : !translationRequestStatus ? (
                      <p className="muted-text translation-log-empty">No translation activity yet.</p>
                    ) : null}
                  </div>
                </div>

                <span className="field-hint">
                  {DEFAULT_AUTO_TRANSLATE_LANGUAGE_NAME} is the source language. Other languages map to GitHub folders by language ID.
                </span>
                {autoTranslateFieldErrors.languages ? (
                  <span className="error-text">{autoTranslateFieldErrors.languages}</span>
                ) : null}
              </div>
            </div>
          </section>

        </div>
      </div>
    </section>
  );
}
