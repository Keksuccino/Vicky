"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { fetchThemes } from "@/components/api";
import type { ThemeDefinition, ThemeMode } from "@/components/types";

type ThemeContextValue = {
  mode: ThemeMode;
  themes: ThemeDefinition[];
  activeThemeId: string | null;
  setMode: (mode: ThemeMode) => void;
  setActiveThemeId: (themeId: string | null) => void;
  refreshThemes: () => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const MODE_STORAGE_KEY = "wiki-theme-mode";
const ACTIVE_THEME_STORAGE_KEY = "wiki-active-theme-id";
const CUSTOM_STYLE_ID = "wiki-custom-theme-style";

function resolveInitialMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
  return stored === "dark" || stored === "custom" ? stored : "light";
}

function resolveInitialThemeId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem(ACTIVE_THEME_STORAGE_KEY);
}

function upsertCustomStyle(cssText: string): void {
  const existing = document.getElementById(CUSTOM_STYLE_ID);

  if (!cssText.trim()) {
    if (existing) {
      existing.remove();
    }
    return;
  }

  if (existing) {
    existing.textContent = cssText;
    return;
  }

  const style = document.createElement("style");
  style.id = CUSTOM_STYLE_ID;
  style.textContent = cssText;
  document.head.appendChild(style);
}

function findBuiltinByMode(themes: ThemeDefinition[], mode: "light" | "dark"): ThemeDefinition | null {
  return themes.find((theme) => theme.isBuiltin && theme.mode === mode) ?? null;
}

function pickThemeForMode(
  themes: ThemeDefinition[],
  mode: ThemeMode,
  selectedThemeId: string | null,
): ThemeDefinition | null {
  if (mode === "custom") {
    if (selectedThemeId) {
      return themes.find((theme) => theme.id === selectedThemeId) ?? null;
    }

    return themes.find((theme) => theme.isActive) ?? themes[0] ?? null;
  }

  return findBuiltinByMode(themes, mode) ?? themes.find((theme) => theme.mode === mode) ?? null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(resolveInitialMode);
  const [themes, setThemes] = useState<ThemeDefinition[]>([]);
  const [activeThemeId, setActiveThemeId] = useState<string | null>(resolveInitialThemeId);
  const appliedCustomVariablesRef = useRef<string[]>([]);

  const refreshThemes = useCallback(async () => {
    try {
      const { themes: nextThemes, activeThemeId: nextActiveThemeId } = await fetchThemes();
      setThemes(nextThemes);
      setActiveThemeId((previous) => {
        if (previous && nextThemes.some((theme) => theme.id === previous)) {
          return previous;
        }

        return nextActiveThemeId;
      });
    } catch {
      setThemes([]);
    }
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void refreshThemes();
    }, 0);

    return () => {
      window.clearTimeout(handle);
    };
  }, [refreshThemes]);

  useEffect(() => {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    if (activeThemeId) {
      window.localStorage.setItem(ACTIVE_THEME_STORAGE_KEY, activeThemeId);
    } else {
      window.localStorage.removeItem(ACTIVE_THEME_STORAGE_KEY);
    }
  }, [activeThemeId]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.colorMode = mode;

    for (const key of appliedCustomVariablesRef.current) {
      root.style.removeProperty(key);
    }
    appliedCustomVariablesRef.current = [];

    const theme = pickThemeForMode(themes, mode, activeThemeId);
    if (!theme) {
      upsertCustomStyle("");
      return;
    }

    const keys: string[] = [];
    for (const [key, value] of Object.entries(theme.variables)) {
      const normalizedKey = key.startsWith("--") ? key : `--${key}`;
      root.style.setProperty(normalizedKey, value);
      keys.push(normalizedKey);
    }

    appliedCustomVariablesRef.current = keys;
    upsertCustomStyle(theme.customCss);
  }, [activeThemeId, mode, themes]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      themes,
      activeThemeId,
      setMode,
      setActiveThemeId,
      refreshThemes,
    }),
    [activeThemeId, mode, refreshThemes, themes],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return context;
}
