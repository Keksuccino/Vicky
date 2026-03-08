import type { ThemeCustomizationSettings } from "@/lib/types";

export type ThemeMode = "light" | "dark";
export type ThemeVariables = Record<string, string>;

const LIGHT_DEFAULT_ACCENT = "#006ecf";
const LIGHT_DEFAULT_SURFACE_ACCENT = "#7db8f0";
const DARK_DEFAULT_ACCENT = "#5caedf";
const DARK_DEFAULT_SURFACE_ACCENT = "#47729c";
const LIGHT_CONTRAST = "#f8fbff";
const DARK_CONTRAST = "#07121e";

export const LIGHT_THEME_BASE_VARIABLES: ThemeVariables = {
  "--surface": "#f8fbff",
  "--surface-elevated": "#ffffff",
  "--surface-muted": "#e9f1ff",
  "--text-primary": "#111b2e",
  "--text-secondary": "#334869",
  "--text-muted": "#5f7393",
  "--border": "#d6e2f2",
  "--accent": LIGHT_DEFAULT_ACCENT,
  "--accent-soft": "#d6ecff",
  "--accent-contrast": LIGHT_CONTRAST,
  "--accent-surface": LIGHT_DEFAULT_SURFACE_ACCENT,
  "--accent-surface-soft": "#dceeff",
  "--accent-surface-contrast": DARK_CONTRAST,
  "--success": "#0f8a58",
  "--danger": "#ca3f54",
  "--header-bg": "rgba(248, 251, 255, 0.88)",
  "--page-gradient": "#f8fbff",
};

export const DARK_THEME_BASE_VARIABLES: ThemeVariables = {
  "--surface": "#121820",
  "--surface-elevated": "#18212c",
  "--surface-muted": "#232f3d",
  "--text-primary": "#e8edf5",
  "--text-secondary": "#c0c9d7",
  "--text-muted": "#96a3b5",
  "--border": "#334153",
  "--accent": DARK_DEFAULT_ACCENT,
  "--accent-soft": "#22384d",
  "--accent-contrast": DARK_CONTRAST,
  "--accent-surface": DARK_DEFAULT_SURFACE_ACCENT,
  "--accent-surface-soft": "#1f3143",
  "--accent-surface-contrast": "#e8edf5",
  "--success": "#2bd08a",
  "--danger": "#ff6a7f",
  "--header-bg": "rgba(19, 27, 38, 0.8)",
  "--page-gradient": "#121820",
};

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

const expandHexColor = (value: string): string | null => {
  const trimmed = value.trim();

  if (!/^#([\da-f]{3}|[\da-f]{6})$/i.test(trimmed)) {
    return null;
  }

  if (trimmed.length === 4) {
    const [r, g, b] = trimmed.slice(1).split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }

  return trimmed.toLowerCase();
};

const hexToRgb = (hex: string): { r: number; g: number; b: number } => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
});

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }): string =>
  `#${[r, g, b]
    .map((value) => clampByte(value).toString(16).padStart(2, "0"))
    .join("")}`;

const hexToRgba = (hex: string, alpha: number): string => {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
};

const mixHexColors = (baseHex: string, overlayHex: string, overlayWeight: number): string => {
  const base = hexToRgb(baseHex);
  const overlay = hexToRgb(overlayHex);
  const ratio = Math.max(0, Math.min(1, overlayWeight));

  return rgbToHex({
    r: base.r + (overlay.r - base.r) * ratio,
    g: base.g + (overlay.g - base.g) * ratio,
    b: base.b + (overlay.b - base.b) * ratio,
  });
};

const toLinearChannel = (channel: number): number => {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (hex: string): number => {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * toLinearChannel(r) + 0.7152 * toLinearChannel(g) + 0.0722 * toLinearChannel(b);
};

export const normalizeAccentColor = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  return expandHexColor(value) ?? fallback;
};

export const DEFAULT_THEME_CUSTOMIZATION = (): ThemeCustomizationSettings => ({
  useSharedAccent: false,
  sharedAccent: LIGHT_DEFAULT_ACCENT,
  sharedSurfaceAccent: LIGHT_DEFAULT_SURFACE_ACCENT,
  lightAccent: LIGHT_DEFAULT_ACCENT,
  lightSurfaceAccent: LIGHT_DEFAULT_SURFACE_ACCENT,
  darkAccent: DARK_DEFAULT_ACCENT,
  darkSurfaceAccent: DARK_DEFAULT_SURFACE_ACCENT,
  customCss: "",
});

export const normalizeThemeCustomization = (
  value: unknown,
  fallback = DEFAULT_THEME_CUSTOMIZATION(),
): ThemeCustomizationSettings => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  return {
    useSharedAccent: typeof source.useSharedAccent === "boolean" ? source.useSharedAccent : fallback.useSharedAccent,
    sharedAccent: normalizeAccentColor(source.sharedAccent, fallback.sharedAccent),
    sharedSurfaceAccent: normalizeAccentColor(
      source.sharedSurfaceAccent,
      typeof source.sharedAccent === "string" ? normalizeAccentColor(source.sharedAccent, fallback.sharedSurfaceAccent) : fallback.sharedSurfaceAccent,
    ),
    lightAccent: normalizeAccentColor(source.lightAccent, fallback.lightAccent),
    lightSurfaceAccent: normalizeAccentColor(
      source.lightSurfaceAccent,
      typeof source.lightAccent === "string" ? normalizeAccentColor(source.lightAccent, fallback.lightSurfaceAccent) : fallback.lightSurfaceAccent,
    ),
    darkAccent: normalizeAccentColor(source.darkAccent, fallback.darkAccent),
    darkSurfaceAccent: normalizeAccentColor(
      source.darkSurfaceAccent,
      typeof source.darkAccent === "string" ? normalizeAccentColor(source.darkAccent, fallback.darkSurfaceAccent) : fallback.darkSurfaceAccent,
    ),
    customCss: typeof source.customCss === "string" ? source.customCss : fallback.customCss,
  };
};

export const resolveAccentColor = (settings: ThemeCustomizationSettings, mode: ThemeMode): string =>
  settings.useSharedAccent
    ? normalizeAccentColor(settings.sharedAccent, mode === "dark" ? DARK_DEFAULT_ACCENT : LIGHT_DEFAULT_ACCENT)
    : mode === "dark"
      ? normalizeAccentColor(settings.darkAccent, DARK_DEFAULT_ACCENT)
      : normalizeAccentColor(settings.lightAccent, LIGHT_DEFAULT_ACCENT);

export const resolveSurfaceAccentColor = (settings: ThemeCustomizationSettings, mode: ThemeMode): string =>
  settings.useSharedAccent
    ? normalizeAccentColor(
        settings.sharedSurfaceAccent,
        mode === "dark" ? DARK_DEFAULT_SURFACE_ACCENT : LIGHT_DEFAULT_SURFACE_ACCENT,
      )
    : mode === "dark"
      ? normalizeAccentColor(settings.darkSurfaceAccent, DARK_DEFAULT_SURFACE_ACCENT)
      : normalizeAccentColor(settings.lightSurfaceAccent, LIGHT_DEFAULT_SURFACE_ACCENT);

const buildSoftColor = (mode: ThemeMode, accent: string, ratio: number): string =>
  mixHexColors(mode === "dark" ? DARK_THEME_BASE_VARIABLES["--surface"] : LIGHT_THEME_BASE_VARIABLES["--surface"], accent, ratio);

const buildAccentContrast = (accent: string): string => (relativeLuminance(accent) >= 0.42 ? DARK_CONTRAST : LIGHT_CONTRAST);

const buildPageGradient = (mode: ThemeMode): string =>
  mode === "dark" ? DARK_THEME_BASE_VARIABLES["--surface"] : LIGHT_THEME_BASE_VARIABLES["--surface"];

const buildMobileFabVariables = (mode: ThemeMode, surfaceAccent: string): ThemeVariables =>
  mode === "dark"
    ? {
        "--mobile-fab-bg": hexToRgba(surfaceAccent, 0.22),
        "--mobile-fab-bg-hover": hexToRgba(surfaceAccent, 0.33),
        "--mobile-fab-bg-active": hexToRgba(surfaceAccent, 0.4),
        "--mobile-fab-border": hexToRgba(surfaceAccent, 0.62),
        "--mobile-fab-shadow": "rgba(2, 8, 18, 0.56)",
        "--mobile-fab-icon": "#eef8ff",
      }
    : {
        "--mobile-fab-bg": hexToRgba(surfaceAccent, 0.24),
        "--mobile-fab-bg-hover": hexToRgba(surfaceAccent, 0.34),
        "--mobile-fab-bg-active": hexToRgba(surfaceAccent, 0.42),
        "--mobile-fab-border": hexToRgba(surfaceAccent, 0.58),
        "--mobile-fab-shadow": "rgba(26, 62, 110, 0.27)",
        "--mobile-fab-icon": "#0f5698",
      };

export const buildThemeVariables = (mode: ThemeMode, settings: ThemeCustomizationSettings): ThemeVariables => {
  const defaults = mode === "dark" ? DARK_THEME_BASE_VARIABLES : LIGHT_THEME_BASE_VARIABLES;
  const accent = resolveAccentColor(settings, mode);
  const surfaceAccent = resolveSurfaceAccentColor(settings, mode);

  return {
    ...defaults,
    "--accent": accent,
    "--accent-soft": buildSoftColor(mode, accent, mode === "dark" ? 0.22 : 0.16),
    "--accent-contrast": buildAccentContrast(accent),
    "--accent-surface": surfaceAccent,
    "--accent-surface-soft": buildSoftColor(mode, surfaceAccent, mode === "dark" ? 0.2 : 0.14),
    "--accent-surface-contrast": buildAccentContrast(surfaceAccent),
    "--page-gradient": buildPageGradient(mode),
    ...buildMobileFabVariables(mode, surfaceAccent),
  };
};

const serializeForInlineScript = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

export const createThemeBootstrapScript = (settings: ThemeCustomizationSettings): string => {
  const themes = {
    light: buildThemeVariables("light", settings),
    dark: buildThemeVariables("dark", settings),
  };
  const serializedThemes = serializeForInlineScript(themes);
  const serializedCustomCss = serializeForInlineScript(settings.customCss);

  return `(function(){try{var mode=window.localStorage.getItem("wiki-theme-mode");mode=mode==="dark"?"dark":"light";var root=document.documentElement;root.dataset.colorMode=mode;var themes=${serializedThemes};var theme=themes[mode]||themes.light;for(var key in theme){root.style.setProperty(key,theme[key]);}var cssText=${serializedCustomCss};var styleId="wiki-custom-theme-style";var existing=document.getElementById(styleId);if(cssText.trim()){if(!existing){existing=document.createElement("style");existing.id=styleId;document.head.appendChild(existing);}existing.textContent=cssText;}else if(existing){existing.remove();}}catch(_error){document.documentElement.dataset.colorMode="light";}})();`;
};
