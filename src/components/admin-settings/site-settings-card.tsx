"use client";

import { useAdminPanel } from "@/components/admin-settings/panel-context";
import { useDraftFields } from "@/components/admin-settings/settings-store";
import { ColorPickerField } from "@/components/color-picker-field";
import { DEFAULT_FOOTER_TEXT } from "@/lib/footer";

const DEFAULT_SITE_TITLE_GRADIENT_FROM = "#3b82f6";
const DEFAULT_SITE_TITLE_GRADIENT_TO = "#22d3ee";

const SITE_FIELDS = [
  "siteTitle",
  "siteDescription",
  "footerText",
  "siteTitleGradientFrom",
  "siteTitleGradientTo",
  "startPage",
  "docsIconPng16Url",
  "docsIconPng32Url",
  "docsIconPng180Url",
] as const;

export function SiteSettingsCard() {
  const { settingsStore } = useAdminPanel();
  const settings = useDraftFields(SITE_FIELDS);

  return (
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
                  onChange={(event) => settingsStore.setDraftField("siteTitle", event.target.value, "pause")}
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
                  onChange={(event) => settingsStore.setDraftField("siteDescription", event.target.value, "pause")}
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
                onChange={(event) => settingsStore.setDraftField("footerText", event.target.value, "pause")}
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
                onChange={(value) => settingsStore.setDraftField("siteTitleGradientFrom", value)}
              />

              <ColorPickerField
                id="site-title-gradient-to"
                label="Site title gradient to (optional)"
                value={settings.siteTitleGradientTo}
                allowEmpty
                fallbackColor={DEFAULT_SITE_TITLE_GRADIENT_TO}
                hint="Pick the end color for the site title gradient. Clear both gradient colors to disable it."
                onChange={(value) => settingsStore.setDraftField("siteTitleGradientTo", value)}
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
                onChange={(event) => settingsStore.setDraftField("startPage", event.target.value, "pause")}
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
                  onChange={(event) => settingsStore.setDraftField("docsIconPng16Url", event.target.value, "pause")}
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
                  onChange={(event) => settingsStore.setDraftField("docsIconPng32Url", event.target.value, "pause")}
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
                onChange={(event) => settingsStore.setDraftField("docsIconPng180Url", event.target.value, "pause")}
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
  );
}
