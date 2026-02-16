"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  activateTheme,
  createTheme,
  deleteTheme,
  fetchAdminSettings,
  formatApiError,
  getCurrentUser,
  logout,
  saveAdminSettings,
  testAdminConnection,
  updateTheme,
} from "@/components/api";
import { MaterialIcon } from "@/components/material-icon";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useTheme } from "@/components/theme-provider";
import type { AdminSettings, ThemeDefinition, ThemeDraft } from "@/components/types";

const INITIAL_SETTINGS: AdminSettings = {
  siteTitle: "Vicky Docs",
  siteDescription: "Documentation knowledge base",
  docsCacheTtlSeconds: 30,
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  githubDocsPath: "docs",
  githubToken: "",
  tokenConfigured: false,
};

const INITIAL_THEME_DRAFT: ThemeDraft = {
  name: "",
  mode: "light",
  variables: [
    { key: "--surface", value: "#f8fbff" },
    { key: "--surface-elevated", value: "#ffffff" },
    { key: "--text-primary", value: "#111b2e" },
    { key: "--accent", value: "#006ecf" },
  ],
  customCss: "",
};

function draftFromTheme(theme: ThemeDefinition): ThemeDraft {
  return {
    id: theme.id,
    name: theme.name,
    mode: theme.mode,
    variables: Object.entries(theme.variables).map(([key, value]) => ({ key, value })),
    customCss: theme.customCss,
  };
}

export function AdminSettingsPanel() {
  const router = useRouter();
  const { themes, refreshThemes, setMode, setActiveThemeId } = useTheme();

  const [settings, setSettings] = useState<AdminSettings>(INITIAL_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);

  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);

  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);

  const [themeDraft, setThemeDraft] = useState<ThemeDraft>(INITIAL_THEME_DRAFT);
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeMessage, setThemeMessage] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);

  const isEditingTheme = Boolean(themeDraft.id);

  const activeTheme = useMemo(() => themes.find((theme) => theme.isActive) ?? null, [themes]);

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

        const { settings: loadedSettings } = await fetchAdminSettings();
        if (!isActive) {
          return;
        }

        setSettings(loadedSettings);
        setClearTokenOnSave(false);
        await refreshThemes();
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
  }, [refreshThemes, router]);

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
        <section className="panel-card">
          <div className="panel-header">
            <h1>Repository settings</h1>
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
            Configure site details and the GitHub repository that stores your markdown pages.
          </p>

          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              setSettingsSaving(true);
              setSettingsMessage(null);
              setLoadingError(null);

              try {
                const saved = await saveAdminSettings(settings, { clearToken: clearTokenOnSave });
                setSettings({
                  ...saved,
                  githubToken: "",
                });
                setClearTokenOnSave(false);
                setSettingsMessage("Settings saved.");
                await refreshThemes();
              } catch (error) {
                setLoadingError(formatApiError(error));
              } finally {
                setSettingsSaving(false);
              }
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
              </label>
            </div>

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
                placeholder={settings.tokenConfigured ? "Saved token configured (leave blank to keep)" : "ghp_..."}
              />
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

        <section className="panel-card">
          <div className="panel-header">
            <h2>Theme management</h2>
            <p className="panel-description">Create and activate custom variable-driven themes.</p>
          </div>

          {themes.length === 0 ? (
            <EmptyState title="No themes available" message="Themes will appear once settings are loaded." />
          ) : (
            <ul className="theme-list">
              {themes.map((theme) => (
                <li key={theme.id} className="theme-item">
                  <div>
                    <strong>{theme.name}</strong>
                    <p>
                      {theme.mode} · {Object.keys(theme.variables).length} variables
                      {theme.isBuiltin ? " · built-in" : ""}
                    </p>
                  </div>
                  <div className="theme-item-actions">
                    {activeTheme?.id === theme.id ? <span className="theme-badge">Active</span> : null}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={async () => {
                        try {
                          const activeThemeId = await activateTheme(theme.id);
                          setMode("custom");
                          setActiveThemeId(activeThemeId);
                          await refreshThemes();
                          setThemeMessage(`Activated ${theme.name}.`);
                          setThemeError(null);
                        } catch (error) {
                          setThemeError(formatApiError(error));
                        }
                      }}
                    >
                      <MaterialIcon name="published_with_changes" />
                      <span>Activate</span>
                    </button>
                    {!theme.isBuiltin ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => {
                            setThemeDraft(draftFromTheme(theme));
                            setThemeMessage(null);
                            setThemeError(null);
                          }}
                        >
                          <MaterialIcon name="edit" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost danger"
                          onClick={async () => {
                            const confirmed = window.confirm(`Delete theme \"${theme.name}\"?`);
                            if (!confirmed) {
                              return;
                            }

                            try {
                              const fallbackThemeId = await deleteTheme(theme.id);
                              if (fallbackThemeId) {
                                setActiveThemeId(fallbackThemeId);
                              }
                              await refreshThemes();
                              if (themeDraft.id === theme.id) {
                                setThemeDraft(INITIAL_THEME_DRAFT);
                              }
                              setThemeMessage(`Deleted ${theme.name}.`);
                              setThemeError(null);
                            } catch (error) {
                              setThemeError(formatApiError(error));
                            }
                          }}
                        >
                          <MaterialIcon name="delete" />
                          <span>Delete</span>
                        </button>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form
            className="theme-editor"
            onSubmit={async (event) => {
              event.preventDefault();
              setThemeSaving(true);
              setThemeMessage(null);
              setThemeError(null);

              const name = themeDraft.name.trim();
              if (!name) {
                setThemeSaving(false);
                setThemeError("Theme name is required.");
                return;
              }

              try {
                if (themeDraft.id) {
                  await updateTheme({ ...themeDraft, id: themeDraft.id, name });
                  setThemeMessage(`Updated ${name}.`);
                } else {
                  await createTheme({ ...themeDraft, name });
                  setThemeMessage(`Created ${name}.`);
                }

                await refreshThemes();
                setThemeDraft(INITIAL_THEME_DRAFT);
              } catch (error) {
                setThemeError(formatApiError(error));
              } finally {
                setThemeSaving(false);
              }
            }}
          >
            <div className="panel-header compact">
              <h3>{isEditingTheme ? "Edit theme" : "Create theme"}</h3>
              {isEditingTheme ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setThemeDraft(INITIAL_THEME_DRAFT)}
                >
                  <MaterialIcon name="close" />
                  <span>Cancel</span>
                </button>
              ) : null}
            </div>

            <div className="field-inline">
              <label className="field-row" htmlFor="theme-name">
                <span className="field-label">Theme name</span>
                <input
                  id="theme-name"
                  className="input"
                  value={themeDraft.name}
                  onChange={(event) => setThemeDraft((prev) => ({ ...prev, name: event.target.value }))}
                  required
                />
              </label>

              <label className="field-row" htmlFor="theme-mode">
                <span className="field-label">Mode profile</span>
                <select
                  id="theme-mode"
                  className="input"
                  value={themeDraft.mode}
                  onChange={(event) =>
                    setThemeDraft((prev) => ({
                      ...prev,
                      mode: event.target.value === "dark" ? "dark" : "light",
                    }))
                  }
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </div>

            <div className="field-stack">
              <div className="panel-header compact">
                <span className="field-label">CSS variables</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() =>
                    setThemeDraft((prev) => ({
                      ...prev,
                      variables: [...prev.variables, { key: "", value: "" }],
                    }))
                  }
                >
                  <MaterialIcon name="add" />
                  <span>Add variable</span>
                </button>
              </div>

              {themeDraft.variables.map((variable, index) => (
                <div key={`${variable.key}-${index}`} className="field-inline variable-row">
                  <input
                    className="input"
                    placeholder="--accent"
                    value={variable.key}
                    onChange={(event) => {
                      const next = [...themeDraft.variables];
                      next[index] = { ...next[index], key: event.target.value };
                      setThemeDraft((prev) => ({ ...prev, variables: next }));
                    }}
                  />
                  <input
                    className="input"
                    placeholder="#6ec3ff"
                    value={variable.value}
                    onChange={(event) => {
                      const next = [...themeDraft.variables];
                      next[index] = { ...next[index], value: event.target.value };
                      setThemeDraft((prev) => ({ ...prev, variables: next }));
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost danger"
                    aria-label="Remove variable"
                    onClick={() => {
                      setThemeDraft((prev) => ({
                        ...prev,
                        variables: prev.variables.filter((_, variableIndex) => variableIndex !== index),
                      }));
                    }}
                  >
                    <MaterialIcon name="remove" />
                  </button>
                </div>
              ))}
            </div>

            <label className="field-row" htmlFor="theme-custom-css">
              <span className="field-label">Custom CSS</span>
              <textarea
                id="theme-custom-css"
                className="input textarea"
                rows={6}
                value={themeDraft.customCss}
                onChange={(event) => setThemeDraft((prev) => ({ ...prev, customCss: event.target.value }))}
                placeholder=".markdown-body a { text-decoration-thickness: 2px; }"
              />
            </label>

            <button type="submit" className="btn btn-primary" disabled={themeSaving}>
              <MaterialIcon name={themeSaving ? "sync" : isEditingTheme ? "save" : "add_circle"} />
              <span>{themeSaving ? "Saving..." : isEditingTheme ? "Update theme" : "Create theme"}</span>
            </button>
          </form>

          {themeMessage ? <p className="success-text">{themeMessage}</p> : null}
          {themeError ? <p className="error-text">{themeError}</p> : null}
        </section>
      </div>
    </section>
  );
}
