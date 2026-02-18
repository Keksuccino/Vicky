"use client";

import { useSyncExternalStore } from "react";

import { MaterialIcon } from "@/components/material-icon";
import { useTheme } from "@/components/theme-provider";
import { type ThemeMode } from "@/components/types";

const modeLabels: Array<{ mode: ThemeMode; label: string; icon: string }> = [
  { mode: "light", label: "Light", icon: "light_mode" },
  { mode: "dark", label: "Dark", icon: "dark_mode" },
];

const subscribe = () => () => {};

export function ThemeSwitcher() {
  const { mode, themes, activeThemeId, setMode, setActiveThemeId } = useTheme();
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);

  const compactTargetMode: "light" | "dark" = mode === "dark" ? "light" : "dark";
  const displayTargetMode: "light" | "dark" = hydrated ? compactTargetMode : "dark";
  const compactIcon = displayTargetMode === "light" ? "light_mode" : "dark_mode";
  const compactLabel = `Switch to ${displayTargetMode} mode`;

  return (
    <div className="theme-switcher" aria-label="Theme controls">
      <div className="mode-toggle" role="group" aria-label="Color mode">
        {modeLabels.map((item) => (
          <button
            key={item.mode}
            type="button"
            className={`mode-button ${hydrated && mode === item.mode ? "mode-button-active" : ""}`}
            onClick={() => setMode(item.mode)}
          >
            <MaterialIcon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        className="mode-toggle-compact"
        onClick={() => setMode(compactTargetMode)}
        aria-label={compactLabel}
        title={compactLabel}
      >
        <MaterialIcon name={compactIcon} />
      </button>

      {hydrated && mode === "custom" ? (
        <label className="theme-picker" htmlFor="custom-theme-select">
          <span className="field-label">Custom theme</span>
          <select
            id="custom-theme-select"
            className="input"
            value={activeThemeId ?? ""}
            onChange={(event) => setActiveThemeId(event.target.value || null)}
          >
            <option value="">System custom theme</option>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
