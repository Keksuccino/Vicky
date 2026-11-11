"use client";

import { LocalizationLanguages } from "@/components/admin-settings/localization-languages";
import { useAdminPanel } from "@/components/admin-settings/panel-context";
import { EnabledToggle, ResetToDefaultButton } from "@/components/admin-settings/settings-fields";
import { useDraftFields, useFieldErrors } from "@/components/admin-settings/settings-store";
import {
  normalizeAutoTranslateRequestTimeoutSeconds,
  validateAutoTranslateRequestTimeoutSeconds,
  validateLocalizationPathInput,
  validateOpenRouterApiKeyInput,
  validateOpenRouterModelInput,
} from "@/components/admin-settings/settings-validation";
import {
  DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  DEFAULT_LOCALIZATION_PATH,
  MIN_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  normalizeLocalizationPath,
} from "@/lib/auto-translate";

const LOCALIZATION_FIELDS = [
  "autoTranslateEnabled",
  "autoTranslateLocalizationPath",
  "autoTranslateOpenRouterModel",
  "autoTranslateRequestTimeoutSeconds",
] as const;

export function LocalizationCard() {
  const { settingsStore } = useAdminPanel();
  const settings = useDraftFields(LOCALIZATION_FIELDS);
  const autoTranslateFieldErrors = useFieldErrors("autoTranslate");

  return (
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
                  // The key and the AI chat switch belong to other cards: they are read from the draft
                  // here, so this card does not re-render while the key is typed.
                  const { aiChatEnabled, openRouterApiKey, openRouterApiKeyConfigured } = settingsStore.getState().draft;
                  settingsStore.setDraftField("autoTranslateEnabled", enabled);
                  settingsStore.patchErrors("openRouter", {
                    apiKey: validateOpenRouterApiKeyInput(openRouterApiKey, openRouterApiKeyConfigured, enabled || aiChatEnabled),
                  });
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
                    settingsStore.setDraftField("autoTranslateLocalizationPath", value, "leave");
                    settingsStore.patchErrors("autoTranslate", { localizationPath: validateLocalizationPathInput(value) });
                  }}
                  onBlur={(event) => {
                    settingsStore.setDraftField("autoTranslateLocalizationPath", normalizeLocalizationPath(event.target.value), "leave");
                    settingsStore.patchErrors("autoTranslate", { localizationPath: null });
                  }}
                  placeholder={DEFAULT_LOCALIZATION_PATH}
                />
                <ResetToDefaultButton
                  disabled={settings.autoTranslateLocalizationPath === DEFAULT_LOCALIZATION_PATH}
                  onClick={() => {
                    settingsStore.setDraftField("autoTranslateLocalizationPath", DEFAULT_LOCALIZATION_PATH);
                    settingsStore.patchErrors("autoTranslate", { localizationPath: null });
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
                    settingsStore.setDraftField("autoTranslateOpenRouterModel", value, "pause");
                    settingsStore.patchErrors("autoTranslate", { openRouterModel: validateOpenRouterModelInput(value, settings.autoTranslateEnabled) });
                  }}
                  placeholder={DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL}
                />
                <ResetToDefaultButton
                  disabled={settings.autoTranslateOpenRouterModel === DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL}
                  onClick={() => {
                    settingsStore.setDraftField("autoTranslateOpenRouterModel", DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL);
                    settingsStore.patchErrors("autoTranslate", { openRouterModel: null });
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
                    settingsStore.setDraftField("autoTranslateRequestTimeoutSeconds", value, "pause");
                    settingsStore.patchErrors("autoTranslate", { requestTimeout: validateAutoTranslateRequestTimeoutSeconds(value) });
                  }}
                  onBlur={(event) => {
                    settingsStore.setDraftField("autoTranslateRequestTimeoutSeconds", normalizeAutoTranslateRequestTimeoutSeconds(Number(event.currentTarget.value)), "pause");
                    settingsStore.patchErrors("autoTranslate", { requestTimeout: null });
                  }}
                />
                <ResetToDefaultButton
                  disabled={
                    settings.autoTranslateRequestTimeoutSeconds ===
                    DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000
                  }
                  onClick={() => {
                    settingsStore.setDraftField("autoTranslateRequestTimeoutSeconds", DEFAULT_AUTO_TRANSLATE_REQUEST_TIMEOUT_MS / 1_000);
                    settingsStore.patchErrors("autoTranslate", { requestTimeout: null });
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

        <LocalizationLanguages />
      </div>
    </section>
  );
}
