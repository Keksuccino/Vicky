"use client";

import { useEffect, useState } from "react";

import { MaterialIcon } from "@/components/material-icon";
import { useTheme } from "@/components/theme-provider";
import { type ThemeMode } from "@/components/types";

const modeLabels: Array<{ mode: ThemeMode; label: string; icon: string }> = [
  { mode: "light", label: "Light", icon: "light_mode" },
  { mode: "dark", label: "Dark", icon: "dark_mode" },
];

export function ThemeSwitcher() {
  const { mode, setMode } = useTheme();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setHydrated(true);
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, []);

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

    </div>
  );
}
