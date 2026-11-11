"use client";

import { useAdminPanel } from "@/components/admin-settings/panel-context";
import { SecretInputRow } from "@/components/admin-settings/settings-fields";
import { useDraftFields, useFieldErrors } from "@/components/admin-settings/settings-store";
import { validateOpenRouterApiKeyInput } from "@/components/admin-settings/settings-validation";

const OPENROUTER_FIELDS = ["openRouterApiKey", "openRouterApiKeyConfigured", "aiChatEnabled", "autoTranslateEnabled"] as const;

export function OpenRouterSettingsCard() {
  const { settingsStore } = useAdminPanel();
  const settings = useDraftFields(OPENROUTER_FIELDS);
  const openRouterFieldErrors = useFieldErrors("openRouter");

  return (
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
              <SecretInputRow
                hasSecret={Boolean(settings.openRouterApiKey.trim() || settings.openRouterApiKeyConfigured)}
                id="openrouter-api-key"
                invalid={Boolean(openRouterFieldErrors.apiKey)}
                placeholder={settings.openRouterApiKeyConfigured ? "Saved OpenRouter key configured (leave blank to keep)" : "sk-or-v1-..."}
                target="openRouterApiKey"
                value={settings.openRouterApiKey}
                onChange={(value) => {
                  settingsStore.setDraftField("openRouterApiKey", value, "leave");
                  settingsStore.patchErrors("openRouter", {
                    apiKey: validateOpenRouterApiKeyInput(value, settings.openRouterApiKeyConfigured, settings.aiChatEnabled || settings.autoTranslateEnabled),
                  });
                }}
              />
              <span className="field-hint">
                Stored encrypted in the local app settings file. Leave blank to keep the existing saved key.
              </span>
              {openRouterFieldErrors.apiKey ? <span className="error-text">{openRouterFieldErrors.apiKey}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
