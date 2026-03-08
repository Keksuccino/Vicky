"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  fetchAdminDomainSslStatus,
  fetchAdminSettings,
  formatApiError,
  getCurrentUser,
  logout,
  saveAdminSettings,
  testAdminConnection,
} from "@/components/api";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState, LoadingState } from "@/components/states";
import { useTheme } from "@/components/theme-provider";
import type { AdminSettings, DomainSslRuntimeStatus, ThemeCustomization } from "@/components/types";
import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import { buildThemeVariables, DEFAULT_THEME_CUSTOMIZATION } from "@/lib/theme";

const THEME_DEFAULTS = DEFAULT_THEME_CUSTOMIZATION();

const INITIAL_SETTINGS: AdminSettings = {
  siteTitle: "Vicky Docs",
  siteDescription: "Documentation knowledge base",
  footerText: "Copyright © {{year}} {{owner}}. All rights reserved.",
  startPage: "/home",
  siteTitleGradientFrom: "",
  siteTitleGradientTo: "",
  docsIconPng16Url: "",
  docsIconPng32Url: "",
  docsIconPng180Url: "",
  docsCacheTtlSeconds: 30,
  customDomain: "",
  letsEncryptEmail: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  githubDocsPath: "docs",
  githubToken: "",
  tokenConfigured: false,
  themeUseSharedAccent: THEME_DEFAULTS.useSharedAccent,
  themeSharedAccent: THEME_DEFAULTS.sharedAccent,
  themeSharedSurfaceAccent: THEME_DEFAULTS.sharedSurfaceAccent,
  themeLightAccent: THEME_DEFAULTS.lightAccent,
  themeLightSurfaceAccent: THEME_DEFAULTS.lightSurfaceAccent,
  themeDarkAccent: THEME_DEFAULTS.darkAccent,
  themeDarkSurfaceAccent: THEME_DEFAULTS.darkSurfaceAccent,
  themeCustomCss: THEME_DEFAULTS.customCss,
};

type DomainFieldErrors = {
  customDomain: string | null;
  letsEncryptEmail: string | null;
};

const EMPTY_DOMAIN_FIELD_ERRORS: DomainFieldErrors = {
  customDomain: null,
  letsEncryptEmail: null,
};

const validateCustomDomainInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return normalizeCustomDomain(trimmed)
    ? null
    : "Enter a valid hostname only (example: docs.example.com, without protocol or path).";
};

const validateLetsEncryptEmailInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return normalizeLetsEncryptEmail(trimmed) ? null : "Enter a valid email address for Let's Encrypt notifications.";
};

const validateDomainFields = (domain: string, email: string): DomainFieldErrors => ({
  customDomain: validateCustomDomainInput(domain),
  letsEncryptEmail: validateLetsEncryptEmailInput(email),
});

const hasDomainFieldErrors = (errors: DomainFieldErrors): boolean => Boolean(errors.customDomain || errors.letsEncryptEmail);

const normalizeDomainFieldsForSave = (settings: AdminSettings): AdminSettings => ({
  ...settings,
  customDomain: normalizeCustomDomain(settings.customDomain),
  letsEncryptEmail: normalizeLetsEncryptEmail(settings.letsEncryptEmail),
});

const themeCustomizationFromSettings = (settings: AdminSettings): ThemeCustomization => ({
  useSharedAccent: settings.themeUseSharedAccent,
  sharedAccent: settings.themeSharedAccent,
  sharedSurfaceAccent: settings.themeSharedSurfaceAccent,
  lightAccent: settings.themeLightAccent,
  lightSurfaceAccent: settings.themeLightSurfaceAccent,
  darkAccent: settings.themeDarkAccent,
  darkSurfaceAccent: settings.themeDarkSurfaceAccent,
  customCss: settings.themeCustomCss,
});

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

type AccentColorFieldProps = {
  hint: string;
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
};

function AccentColorField({ hint, id, label, value, onChange }: AccentColorFieldProps) {
  return (
    <label className="field-row" htmlFor={id}>
      <span className="field-label">{label}</span>
      <div className="theme-color-input-row">
        <input
          id={id}
          className="theme-color-picker"
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="theme-color-value" aria-live="polite">
          {value.toUpperCase()}
        </span>
      </div>
      <span className="field-hint">{hint}</span>
    </label>
  );
}

const statusToneClassName = (status: DomainSslRuntimeStatus): "success-text" | "warning-text" | "error-text" => {
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

const formatStatusTimestamp = (value: string): string => {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }

  return parsed.toLocaleString();
};

export function AdminSettingsPanel() {
  const router = useRouter();
  const { setThemeSettings } = useTheme();

  const [settings, setSettings] = useState<AdminSettings>(INITIAL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);

  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);
  const [domainFieldErrors, setDomainFieldErrors] = useState<DomainFieldErrors>(EMPTY_DOMAIN_FIELD_ERRORS);

  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);

  const [sslStatus, setSslStatus] = useState<DomainSslRuntimeStatus | null>(null);
  const [sslStatusLoading, setSslStatusLoading] = useState(true);
  const [sslStatusError, setSslStatusError] = useState<string | null>(null);

  const [themeSaving, setThemeSaving] = useState(false);
  const [themeMessage, setThemeMessage] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);

  const themeCustomization = useMemo(() => themeCustomizationFromSettings(settings), [settings]);
  const lightPreviewStyle = useMemo(
    () => createThemePreviewStyle("light", themeCustomization),
    [themeCustomization],
  );
  const darkPreviewStyle = useMemo(
    () => createThemePreviewStyle("dark", themeCustomization),
    [themeCustomization],
  );

  const refreshSslStatus = useCallback(async () => {
    setSslStatusLoading(true);
    setSslStatusError(null);

    try {
      const status = await fetchAdminDomainSslStatus();
      setSslStatus(status);
    } catch (error) {
      setSslStatus(null);
      setSslStatusError(formatApiError(error));
    } finally {
      setSslStatusLoading(false);
    }
  }, []);

  const saveSettingsChanges = useCallback(
    async (clearToken: boolean) => {
      const domainErrors = validateDomainFields(settings.customDomain, settings.letsEncryptEmail);
      setDomainFieldErrors(domainErrors);

      if (hasDomainFieldErrors(domainErrors)) {
        setSettingsMessage(null);
        setConnectionMessage(null);
        return;
      }

      setSettingsSaving(true);
      setSettingsMessage(null);
      setLoadingError(null);

      try {
        const saved = await saveAdminSettings(normalizeDomainFieldsForSave(settings), { clearToken });
        setSettings({
          ...saved,
          githubToken: "",
        });
        setThemeSettings(themeCustomizationFromSettings(saved));
        setDomainFieldErrors(validateDomainFields(saved.customDomain, saved.letsEncryptEmail));
        setClearTokenOnSave(false);
        setSettingsMessage("Settings saved.");
        await refreshSslStatus();
      } catch (error) {
        setLoadingError(formatApiError(error));
      } finally {
        setSettingsSaving(false);
      }
    },
    [refreshSslStatus, setThemeSettings, settings],
  );

  const saveThemeChanges = useCallback(async () => {
    const domainErrors = validateDomainFields(settings.customDomain, settings.letsEncryptEmail);
    setDomainFieldErrors(domainErrors);

    if (hasDomainFieldErrors(domainErrors)) {
      setThemeMessage(null);
      setThemeError("Fix the domain settings errors first, then save the theme customization.");
      return;
    }

    setThemeSaving(true);
    setThemeMessage(null);
    setThemeError(null);

    try {
      const saved = await saveAdminSettings(normalizeDomainFieldsForSave(settings), { clearToken: false });
      setSettings({
        ...saved,
        githubToken: "",
      });
      setThemeSettings(themeCustomizationFromSettings(saved));
      setThemeMessage("Theme customization saved.");
    } catch (error) {
      setThemeError(formatApiError(error));
    } finally {
      setThemeSaving(false);
    }
  }, [setThemeSettings, settings]);

  useEffect(() => {
    let isActive = true;

    const run = async () => {
      setLoading(true);
      setLoadingError(null);

      try {
        const currentUser = await getCurrentUser();
        if (!currentUser) {
          router.replace("/admin/login");
          return;
        }

        const loadedSettings = await fetchAdminSettings();
        if (!isActive) {
          return;
        }

        setSettings(loadedSettings);
        setThemeSettings(themeCustomizationFromSettings(loadedSettings));
        setDomainFieldErrors(validateDomainFields(loadedSettings.customDomain, loadedSettings.letsEncryptEmail));
        setClearTokenOnSave(false);
        await refreshSslStatus();
      } catch (error) {
        if (isActive) {
          setLoadingError(formatApiError(error));
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      isActive = false;
    };
  }, [refreshSslStatus, router, setThemeSettings]);

  if (loading) {
    return <LoadingState label="Loading admin settings..." />;
  }

  if (loadingError) {
    return (
      <ErrorState
        title="Unable to load admin settings"
        message={loadingError}
        actionLabel="Retry"
        onAction={() => window.location.reload()}
      />
    );
  }

  return (
    <section className="admin-page">
      <div className="panel-grid">
        <section className="panel-card panel-card-repo">
          <div className="panel-header">
            <h1>Repository Settings</h1>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={async () => {
                await logout();
                router.replace("/admin/login");
              }}
            >
              <MaterialIcon name="logout" />
              <span>Sign out</span>
            </button>
          </div>

          <p className="panel-description">
            Configure repository connectivity, write credentials, and docs cache behavior.
          </p>

          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              await saveSettingsChanges(clearTokenOnSave);
            }}
          >
            <label className="field-row" htmlFor="docs-cache-ttl-seconds">
              <span className="field-label">Docs cache TTL (seconds)</span>
              <input
                id="docs-cache-ttl-seconds"
                className="input"
                type="number"
                min={1}
                max={86400}
                step={1}
                value={settings.docsCacheTtlSeconds}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  const normalized = Number.isFinite(parsed) ? Math.min(86400, Math.max(1, parsed)) : 1;
                  setSettings((prev) => ({ ...prev, docsCacheTtlSeconds: normalized }));
                }}
                required
              />
              <span className="field-hint">
                Allowed range: 1-86400. Lower values refresh docs faster; higher values reduce GitHub API calls.
              </span>
            </label>

            <label className="field-row" htmlFor="github-token">
              <span className="field-label">GitHub token</span>
              <input
                id="github-token"
                className="input"
                type="password"
                autoComplete="off"
                value={settings.githubToken}
                onChange={(event) => {
                  setSettings((prev) => ({ ...prev, githubToken: event.target.value }));
                  setClearTokenOnSave(false);
                }}
                placeholder={
                  settings.tokenConfigured ? "Saved token configured (leave blank to keep)" : "github_pat_... or ghp_..."
                }
              />
              <span className="field-hint">
                Use a PAT for this repo. Minimum permissions: Contents (read/write) and Metadata (read-only).
              </span>
              {settings.tokenConfigured ? (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={clearTokenOnSave}
                    onChange={(event) => setClearTokenOnSave(event.target.checked)}
                  />
                  <span>Clear currently saved token on next save</span>
                </label>
              ) : null}
            </label>

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
                <span className="field-hint">GitHub user or org name only. Example: `Keksuccino`.</span>
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
                <span className="field-hint">Repository name only. Example: `Vicky` (no owner, no `.git`).</span>
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
                <span className="field-hint">Existing branch name. Example: `main`.</span>
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
                <span className="field-hint">Folder inside the repo where markdown files live. Example: `docs`.</span>
              </label>
            </div>

            <div className="action-row">
              <button type="submit" className="btn btn-primary" disabled={settingsSaving}>
                <MaterialIcon name={settingsSaving ? "sync" : "save"} />
                <span>{settingsSaving ? "Saving..." : "Save settings"}</span>
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                disabled={testingConnection}
                onClick={async () => {
                  setTestingConnection(true);
                  setConnectionMessage(null);
                  setLoadingError(null);

                  try {
                    const message = await testAdminConnection(settings);
                    setConnectionMessage(message);
                  } catch (error) {
                    setLoadingError(formatApiError(error));
                  } finally {
                    setTestingConnection(false);
                  }
                }}
              >
                <MaterialIcon name={testingConnection ? "hourglass_top" : "network_check"} />
                <span>{testingConnection ? "Testing..." : "Test connection"}</span>
              </button>
            </div>
          </form>

          {settingsMessage ? <p className="success-text">{settingsMessage}</p> : null}
          {connectionMessage ? <p className="success-text">{connectionMessage}</p> : null}
          {loadingError ? <p className="error-text">{loadingError}</p> : null}
        </section>

        <section className="panel-card panel-card-theme">
          <div className="panel-header">
            <h2>Theme Management</h2>
            <p className="panel-description">Customize the built-in Light and Dark modes with a simpler accent setup.</p>
          </div>

          <form
            className="theme-editor"
            onSubmit={async (event) => {
              event.preventDefault();
              await saveThemeChanges();
            }}
          >
            <div className="theme-customization-intro">
              <strong>Two simple accents per built-in theme</strong>
              <p>
                The Light/Dark switch in the top-right stays the same. Use a main accent for links, highlights, and
                primary buttons, then a surface/background accent for the sidebar, header controls, hover surfaces, and
                page background glow.
              </p>
            </div>

            <label className="checkbox-row theme-shared-toggle">
              <input
                type="checkbox"
                checked={settings.themeUseSharedAccent}
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
                    themeUseSharedAccent: event.target.checked,
                  }))
                }
              />
              <span>Use the same accent colors for Light and Dark mode</span>
            </label>

            <div className="theme-color-grid">
              {settings.themeUseSharedAccent ? (
                <div className="field-inline">
                  <AccentColorField
                    id="theme-shared-accent"
                    label="Shared main accent"
                    value={settings.themeSharedAccent}
                    hint="Used for links, highlights, focus states, and primary action buttons in both modes."
                    onChange={(value) => setSettings((prev) => ({ ...prev, themeSharedAccent: value }))}
                  />
                  <AccentColorField
                    id="theme-shared-surface-accent"
                    label="Shared surface/background accent"
                    value={settings.themeSharedSurfaceAccent}
                    hint="Used for sidebar surfaces, header controls, page-entry hovers, and the page background glow."
                    onChange={(value) => setSettings((prev) => ({ ...prev, themeSharedSurfaceAccent: value }))}
                  />
                </div>
              ) : (
                <>
                  <div className="theme-color-section">
                    <strong className="theme-color-section-title">Light mode</strong>
                    <div className="field-inline">
                      <AccentColorField
                        id="theme-light-accent"
                        label="Main accent"
                        value={settings.themeLightAccent}
                        hint="Used for links, highlights, focus states, and primary action buttons in Light mode."
                        onChange={(value) => setSettings((prev) => ({ ...prev, themeLightAccent: value }))}
                      />
                      <AccentColorField
                        id="theme-light-surface-accent"
                        label="Surface/background accent"
                        value={settings.themeLightSurfaceAccent}
                        hint="Used for sidebar surfaces, header controls, page-entry hovers, and the page glow in Light mode."
                        onChange={(value) => setSettings((prev) => ({ ...prev, themeLightSurfaceAccent: value }))}
                      />
                    </div>
                  </div>

                  <div className="theme-color-section">
                    <strong className="theme-color-section-title">Dark mode</strong>
                    <div className="field-inline">
                      <AccentColorField
                        id="theme-dark-accent"
                        label="Main accent"
                        value={settings.themeDarkAccent}
                        hint="Used for links, highlights, focus states, and primary action buttons in Dark mode."
                        onChange={(value) => setSettings((prev) => ({ ...prev, themeDarkAccent: value }))}
                      />
                      <AccentColorField
                        id="theme-dark-surface-accent"
                        label="Surface/background accent"
                        value={settings.themeDarkSurfaceAccent}
                        hint="Used for sidebar surfaces, header controls, page-entry hovers, and the page glow in Dark mode."
                        onChange={(value) => setSettings((prev) => ({ ...prev, themeDarkSurfaceAccent: value }))}
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="action-row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() =>
                    setSettings((prev) => ({
                      ...prev,
                      themeUseSharedAccent: THEME_DEFAULTS.useSharedAccent,
                      themeSharedAccent: THEME_DEFAULTS.sharedAccent,
                      themeSharedSurfaceAccent: THEME_DEFAULTS.sharedSurfaceAccent,
                      themeLightAccent: THEME_DEFAULTS.lightAccent,
                      themeLightSurfaceAccent: THEME_DEFAULTS.lightSurfaceAccent,
                      themeDarkAccent: THEME_DEFAULTS.darkAccent,
                      themeDarkSurfaceAccent: THEME_DEFAULTS.darkSurfaceAccent,
                    }))
                  }
                >
                  <MaterialIcon name="restart_alt" />
                  <span>Reset accent colors</span>
                </button>
              </div>
            </div>

            <div className="theme-preview-grid">
              <div className="theme-preview-card" style={lightPreviewStyle}>
                <div className="theme-preview-header">
                  <strong>Light mode</strong>
                  <span className="theme-preview-chip">Preview</span>
                </div>
                <p className="theme-preview-copy">
                  Main accent drives links and primary actions. Surface/background accent drives sidebar and header UI.
                </p>
                <div className="theme-preview-actions">
                  <span className="theme-preview-link">Example link</span>
                  <span className="theme-preview-surface-chip">Sidebar tab</span>
                  <button type="button" className="theme-preview-button">
                    Primary action
                  </button>
                </div>
              </div>

              <div className="theme-preview-card" style={darkPreviewStyle}>
                <div className="theme-preview-header">
                  <strong>Dark mode</strong>
                  <span className="theme-preview-chip">Preview</span>
                </div>
                <p className="theme-preview-copy">
                  The page glow, top-right controls, and sidebar surfaces all reuse the secondary accent in Dark mode.
                </p>
                <div className="theme-preview-actions">
                  <span className="theme-preview-link">Example link</span>
                  <span className="theme-preview-surface-chip">Header control</span>
                  <button type="button" className="theme-preview-button">
                    Primary action
                  </button>
                </div>
              </div>
            </div>

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

            <button type="submit" className="btn btn-primary" disabled={themeSaving}>
              <MaterialIcon name={themeSaving ? "sync" : "save"} />
              <span>{themeSaving ? "Saving..." : "Save theme customization"}</span>
            </button>
          </form>

          {themeMessage ? <p className="success-text">{themeMessage}</p> : null}
          {themeError ? <p className="error-text">{themeError}</p> : null}
        </section>

        <section className="panel-card panel-card-site">
          <div className="panel-header">
            <h2>Site Settings</h2>
          </div>

          <p className="panel-description">Configure site branding, footer text, start page behavior, and icon assets.</p>

          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              await saveSettingsChanges(false);
            }}
          >
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
              <span className="field-label">Footer text (supports {`{{year}}`} and {`{{owner}}`})</span>
              <input
                id="site-footer-text"
                className="input"
                value={settings.footerText}
                onChange={(event) => setSettings((prev) => ({ ...prev, footerText: event.target.value }))}
                placeholder="Copyright © {{year}} {{owner}}. All rights reserved."
                required
              />
              <span className="field-hint">
                <code>{`{{year}}`}</code> and <code>{`{{owner}}`}</code> are replaced automatically; all other text is
                rendered as-is.
              </span>
            </label>

            <div className="field-inline">
              <label className="field-row" htmlFor="site-title-gradient-from">
                <span className="field-label">Site title gradient from (optional)</span>
                <input
                  id="site-title-gradient-from"
                  className="input"
                  value={settings.siteTitleGradientFrom}
                  onChange={(event) => setSettings((prev) => ({ ...prev, siteTitleGradientFrom: event.target.value }))}
                  placeholder="#3b82f6"
                />
                <span className="field-hint">Any CSS color value. Example: `#3b82f6`, `rgb(59 130 246)`.</span>
              </label>

              <label className="field-row" htmlFor="site-title-gradient-to">
                <span className="field-label">Site title gradient to (optional)</span>
                <input
                  id="site-title-gradient-to"
                  className="input"
                  value={settings.siteTitleGradientTo}
                  onChange={(event) => setSettings((prev) => ({ ...prev, siteTitleGradientTo: event.target.value }))}
                  placeholder="#22d3ee"
                />
                <span className="field-hint">Any CSS color value. Leave both gradient fields empty to disable.</span>
              </label>
            </div>

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
                Preferred format: `/home`. `/docs/home` and full docs URLs are normalized automatically.
              </span>
            </label>

            <div className="form-separator" role="separator" aria-hidden="true" />

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

            <div className="action-row">
              <button type="submit" className="btn btn-primary" disabled={settingsSaving}>
                <MaterialIcon name={settingsSaving ? "sync" : "save"} />
                <span>{settingsSaving ? "Saving..." : "Save settings"}</span>
              </button>
            </div>
          </form>
        </section>

        <section className="panel-card panel-card-domain">
          <div className="panel-header">
            <h2>Domain Settings</h2>
          </div>

          <p className="panel-description">
            Configure your custom domain and Let&apos;s Encrypt contact email for automatic HTTPS certificate management.
          </p>

          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              await saveSettingsChanges(false);
            }}
          >
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
                Hostname only (no protocol or path). Example: <code>fancymenu.net</code> or{" "}
                <code>docs.fancymenu.net</code>.
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

            <div className="field-row">
              <span className="field-label">SSL runtime status</span>
              {sslStatusLoading ? <span className="field-hint">Checking certificate runtime status...</span> : null}
              {!sslStatusLoading && sslStatus ? (
                <>
                  <p className={statusToneClassName(sslStatus)}>{sslStatus.message}</p>
                  <span className="field-hint">
                    Source:{" "}
                    {sslStatus.source === "runtime" ? "runtime status endpoint" : "best-effort check (settings + local cert files)"}.
                  </span>
                  {sslStatus.certificateExpiresAt ? (
                    <span className="field-hint">
                      Certificate expiry: {formatStatusTimestamp(sslStatus.certificateExpiresAt)}.
                    </span>
                  ) : null}
                  <span className="field-hint">Last checked: {formatStatusTimestamp(sslStatus.checkedAt)}.</span>
                </>
              ) : null}
              {sslStatusError ? <p className="warning-text">Could not load SSL runtime status: {sslStatusError}</p> : null}
            </div>

            <p className="warning-text">
              Automatic SSL runs only when both values are set and DNS points this domain to your server.
            </p>

            <div className="action-row">
              <button type="submit" className="btn btn-primary" disabled={settingsSaving}>
                <MaterialIcon name={settingsSaving ? "sync" : "save"} />
                <span>{settingsSaving ? "Saving..." : "Save settings"}</span>
              </button>
            </div>
          </form>
        </section>
      </div>
    </section>
  );
}
