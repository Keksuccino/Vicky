"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { buildThemeVariables } from "@/lib/theme";

import type { ThemeCustomization, ThemeMode } from "@/components/types";

type ThemeContextValue = {
  mode: ThemeMode;
  themeSettings: ThemeCustomization;
  setMode: (mode: ThemeMode) => void;
  setThemeSettings: (settings: ThemeCustomization) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const MODE_STORAGE_KEY = "wiki-theme-mode";
const CUSTOM_STYLE_ID = "wiki-custom-theme-style";
const THEME_TRANSITION_CLASS = "theme-color-transitioning";
const THEME_TRANSITION_MS = 180;

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

export function ThemeProvider({
  children,
  initialThemeSettings,
}: {
  children: ReactNode;
  initialThemeSettings: ThemeCustomization;
}) {
  const [mode, setMode] = useState<ThemeMode>("light");
  const [themeSettings, setThemeSettings] = useState<ThemeCustomization>(initialThemeSettings);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const appliedCustomVariablesRef = useRef<string[]>([]);
  const hasAppliedThemeRef = useRef(false);
  const transitionTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setThemeSettings(initialThemeSettings);
  }, [initialThemeSettings]);

  useEffect(() => {
    try {
      const storedMode = window.localStorage.getItem(MODE_STORAGE_KEY);
      if (storedMode === "dark") {
        setMode("dark");
      }
    } catch {
      // Keep defaults if storage is unavailable.
    } finally {
      setStorageHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!storageHydrated) {
      return;
    }

    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode, storageHydrated]);

  useLayoutEffect(() => {
    if (!storageHydrated) {
      return;
    }

    const root = document.documentElement;
    const shouldTransition =
      hasAppliedThemeRef.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (transitionTimeoutRef.current !== null) {
      window.clearTimeout(transitionTimeoutRef.current);
      transitionTimeoutRef.current = null;
    }

    if (shouldTransition) {
      root.classList.add(THEME_TRANSITION_CLASS);
      root.getBoundingClientRect();
    }

    root.dataset.colorMode = mode;

    for (const key of appliedCustomVariablesRef.current) {
      root.style.removeProperty(key);
    }
    appliedCustomVariablesRef.current = [];

    const variables = buildThemeVariables(mode, themeSettings);
    const keys: string[] = [];

    for (const [key, value] of Object.entries(variables)) {
      root.style.setProperty(key, value);
      keys.push(key);
    }

    appliedCustomVariablesRef.current = keys;
    upsertCustomStyle(themeSettings.customCss);
    hasAppliedThemeRef.current = true;

    if (shouldTransition) {
      transitionTimeoutRef.current = window.setTimeout(() => {
        root.classList.remove(THEME_TRANSITION_CLASS);
        transitionTimeoutRef.current = null;
      }, THEME_TRANSITION_MS);
    } else {
      root.classList.remove(THEME_TRANSITION_CLASS);
    }
  }, [mode, storageHydrated, themeSettings]);

  useEffect(() => {
    return () => {
      if (transitionTimeoutRef.current !== null) {
        window.clearTimeout(transitionTimeoutRef.current);
      }
      document.documentElement.classList.remove(THEME_TRANSITION_CLASS);
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      themeSettings,
      setMode,
      setThemeSettings,
    }),
    [mode, themeSettings],
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
