"use client";

import { useCallback, useState } from "react";

import { formatCount, formatStatusTimestamp } from "@/components/admin-settings/format";
import { useAdminPanel } from "@/components/admin-settings/panel-context";
import { SecretInputRow } from "@/components/admin-settings/settings-fields";
import { useDraftFields } from "@/components/admin-settings/settings-store";
import {
  formatApiError,
  MAX_DOCS_REFRESH_INTERVAL_MINUTES,
  MIN_DOCS_REFRESH_INTERVAL_MINUTES,
  refreshAdminDocsCache,
  testAdminConnection,
} from "@/components/api";
import { MaterialIcon } from "@/components/material-icon";

const REPOSITORY_FIELDS = [
  "docsRefreshIntervalMinutes",
  "githubToken",
  "tokenConfigured",
  "githubOwner",
  "githubRepo",
  "githubBranch",
  "githubDocsPath",
] as const;

export function RepositorySettingsCard() {
  const { lifetimeSignal, persistLatestSettings, refreshRequestedMarkdownCacheStatus, refreshTranslationOverview, settingsStore } = useAdminPanel();
  const settings = useDraftFields(REPOSITORY_FIELDS);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [refreshingDocs, setRefreshingDocs] = useState(false);
  const [docsRefreshMessage, setDocsRefreshMessage] = useState<string | null>(null);
  const [docsRefreshError, setDocsRefreshError] = useState<string | null>(null);

  /** Fetches the docs from GitHub now; the localization and Markdown cache statuses follow the new pages. */
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

  /** Tests the draft's repository settings, which may not be saved yet. */
  const testConnection = async () => {
    const signal = lifetimeSignal();
    setTestingConnection(true);
    setConnectionMessage(null);
    setConnectionError(null);

    try {
      const message = await testAdminConnection(settingsStore.getState().draft, { signal });
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
  };

  return (
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
                  settingsStore.setDraftField("docsRefreshIntervalMinutes", normalized);
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
              <SecretInputRow
                hasSecret={Boolean(settings.githubToken.trim() || settings.tokenConfigured)}
                id="github-token"
                placeholder={settings.tokenConfigured ? "Saved token configured (leave blank to keep)" : "github_pat_... or ghp_..."}
                target="githubToken"
                value={settings.githubToken}
                onChange={(value) => settingsStore.setDraftField("githubToken", value)}
              />
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
                  onChange={(event) => settingsStore.setDraftField("githubOwner", event.target.value)}
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
                  onChange={(event) => settingsStore.setDraftField("githubRepo", event.target.value)}
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
                  onChange={(event) => settingsStore.setDraftField("githubBranch", event.target.value)}
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
                  onChange={(event) => settingsStore.setDraftField("githubDocsPath", event.target.value)}
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

              <button type="button" className="btn" disabled={testingConnection} onClick={testConnection}>
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
  );
}
