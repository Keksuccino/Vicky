"use client";

import { useMemo, type CSSProperties } from "react";

import { useAdminPanel } from "@/components/admin-settings/panel-context";
import { themeCustomizationFromSettings, useDraftFields } from "@/components/admin-settings/settings-store";
import { ColorPickerField } from "@/components/color-picker-field";
import type { ThemeCustomization } from "@/components/types";
import { buildThemeVariables, DEFAULT_THEME_CUSTOMIZATION } from "@/lib/theme";

const THEME_DEFAULTS = DEFAULT_THEME_CUSTOMIZATION();

const THEME_FIELDS = ["themeLightAccent", "themeLightSurfaceAccent", "themeDarkAccent", "themeDarkSurfaceAccent", "themeCustomCss"] as const;

/** The theme's colors in `mode` as the variables the preview cards read, so they show the draft before it is saved. */
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

function ThemePreviewCard({ style, title }: { style: CSSProperties; title: string }) {
  return (
    <div className="theme-preview-card" style={style}>
      <div className="theme-preview-header">
        <strong>{title}</strong>
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
  );
}

export function ThemeSettingsCard() {
  const { settingsStore } = useAdminPanel();
  const settings = useDraftFields(THEME_FIELDS);
  const themeCustomization = useMemo(() => themeCustomizationFromSettings(settings), [settings]);
  const lightPreviewStyle = useMemo(
    () => createThemePreviewStyle("light", themeCustomization),
    [themeCustomization],
  );
  const darkPreviewStyle = useMemo(
    () => createThemePreviewStyle("dark", themeCustomization),
    [themeCustomization],
  );

  return (
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
                onChange={(value) => settingsStore.setDraftField("themeLightSurfaceAccent", value)}
              />
              <ColorPickerField
                id="theme-light-accent"
                label="Emphasis accent"
                value={settings.themeLightAccent}
                fallbackColor={THEME_DEFAULTS.lightAccent}
                showReset
                hint="Used for links, primary actions, active states, focus borders, and strong highlights in Light mode."
                onChange={(value) => settingsStore.setDraftField("themeLightAccent", value)}
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
                onChange={(value) => settingsStore.setDraftField("themeDarkSurfaceAccent", value)}
              />
              <ColorPickerField
                id="theme-dark-accent"
                label="Emphasis accent"
                value={settings.themeDarkAccent}
                fallbackColor={THEME_DEFAULTS.darkAccent}
                showReset
                hint="Used for links, primary actions, active states, focus borders, and strong highlights in Dark mode."
                onChange={(value) => settingsStore.setDraftField("themeDarkAccent", value)}
              />
            </div>
          </div>
        </div>

        <div className="theme-preview-grid">
          <ThemePreviewCard style={lightPreviewStyle} title="Light mode" />
          <ThemePreviewCard style={darkPreviewStyle} title="Dark mode" />
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
                onChange={(event) => settingsStore.setDraftField("themeCustomCss", event.target.value, "pause")}
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
  );
}
