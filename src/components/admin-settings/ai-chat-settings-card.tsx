"use client";

import { useAdminPanel } from "@/components/admin-settings/panel-context";
import { EnabledToggle, ResetToDefaultButton } from "@/components/admin-settings/settings-fields";
import { useDraftFields, useFieldErrors } from "@/components/admin-settings/settings-store";
import { validateOpenRouterModelInput, validateSystemPromptInput } from "@/components/admin-settings/settings-validation";
import {
  AI_CHAT_ASSISTANT_NAME_PLACEHOLDER,
  AI_CHAT_DOCS_PLACEHOLDER,
  DEFAULT_AI_CHAT_ASSISTANT_NAME,
  DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  DEFAULT_AI_CHAT_OPENROUTER_MODEL,
  DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
} from "@/lib/ai-chat";

const AI_CHAT_FIELDS = [
  "aiChatEnabled",
  "aiChatAssistantName",
  "aiChatAvatarUrl",
  "aiChatHeaderSubtitle",
  "aiChatWelcomeMessage",
  "openRouterModel",
  "aiChatSystemPrompt",
] as const;

export function AiChatSettingsCard() {
  const { settingsStore } = useAdminPanel();
  const settings = useDraftFields(AI_CHAT_FIELDS);
  const aiChatFieldErrors = useFieldErrors("aiChat");

  return (
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
                onChange={(enabled) => settingsStore.setDraftField("aiChatEnabled", enabled)}
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
                  onChange={(event) => settingsStore.setDraftField("aiChatAssistantName", event.target.value, "pause")}
                  placeholder={DEFAULT_AI_CHAT_ASSISTANT_NAME}
                />
                <ResetToDefaultButton
                  disabled={settings.aiChatAssistantName === DEFAULT_AI_CHAT_ASSISTANT_NAME}
                  onClick={() =>
                    settingsStore.setDraftField("aiChatAssistantName", DEFAULT_AI_CHAT_ASSISTANT_NAME)
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
                onChange={(event) => settingsStore.setDraftField("aiChatAvatarUrl", event.target.value, "pause")}
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
                  onChange={(event) => settingsStore.setDraftField("aiChatHeaderSubtitle", event.target.value, "pause")}
                  placeholder={DEFAULT_AI_CHAT_HEADER_SUBTITLE}
                />
                <ResetToDefaultButton
                  disabled={settings.aiChatHeaderSubtitle === DEFAULT_AI_CHAT_HEADER_SUBTITLE}
                  onClick={() =>
                    settingsStore.setDraftField("aiChatHeaderSubtitle", DEFAULT_AI_CHAT_HEADER_SUBTITLE)
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
                  onChange={(event) => settingsStore.setDraftField("aiChatWelcomeMessage", event.target.value, "pause")}
                  placeholder={DEFAULT_AI_CHAT_WELCOME_MESSAGE}
                />
                <ResetToDefaultButton
                  disabled={settings.aiChatWelcomeMessage === DEFAULT_AI_CHAT_WELCOME_MESSAGE}
                  onClick={() =>
                    settingsStore.setDraftField("aiChatWelcomeMessage", DEFAULT_AI_CHAT_WELCOME_MESSAGE)
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
                    settingsStore.setDraftField("openRouterModel", value, "pause");
                    settingsStore.patchErrors("aiChat", { openRouterModel: validateOpenRouterModelInput(value, settings.aiChatEnabled) });
                  }}
                  placeholder={DEFAULT_AI_CHAT_OPENROUTER_MODEL}
                />
                <ResetToDefaultButton
                  disabled={settings.openRouterModel === DEFAULT_AI_CHAT_OPENROUTER_MODEL}
                  onClick={() => {
                    settingsStore.setDraftField("openRouterModel", DEFAULT_AI_CHAT_OPENROUTER_MODEL);
                    settingsStore.patchErrors("aiChat", { openRouterModel: null });
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
                    settingsStore.setDraftField("aiChatSystemPrompt", value, "pause");
                    settingsStore.patchErrors("aiChat", { systemPrompt: validateSystemPromptInput(value, settings.aiChatEnabled) });
                  }}
                  placeholder={DEFAULT_AI_CHAT_SYSTEM_PROMPT}
                />
                <ResetToDefaultButton
                  disabled={settings.aiChatSystemPrompt === DEFAULT_AI_CHAT_SYSTEM_PROMPT}
                  onClick={() => {
                    settingsStore.setDraftField("aiChatSystemPrompt", DEFAULT_AI_CHAT_SYSTEM_PROMPT);
                    settingsStore.patchErrors("aiChat", { systemPrompt: null });
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
  );
}
