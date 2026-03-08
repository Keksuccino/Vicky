import type { ThemeCustomizationSettings } from "@/lib/types";

export type ThemeMode = "light" | "dark";
export type ThemeVariables = Record<string, string>;

export const LIGHT_THEME_BASE_VARIABLES: ThemeVariables = {
  "--surface": "#f8fbff",
  "--surface-elevated": "#ffffff",
  "--surface-muted": "#e9f1ff",
  "--text-primary": "#111b2e",
  "--text-secondary": "#334869",
  "--text-muted": "#5f7393",
  "--border": "#d6e2f2",
  "--accent": "#006ecf",
  "--accent-soft": "#d6ecff",
  "--accent-contrast": "#f8fbff",
  "--success": "#0f8a58",
  "--danger": "#ca3f54",
  "--header-bg": "rgba(248, 251, 255, 0.88)",
  "--page-gradient":
    "radial-gradient(circle at 12% 0%, #e3f1ff 0%, transparent 35%), radial-gradient(circle at 88% 8%, #d8eaff 0%, transparent 25%), linear-gradient(180deg, #eff6ff 0%, #f6faff 45%, #edf4ff 100%)",
};

export const DARK_THEME_BASE_VARIABLES: ThemeVariables = {
  "--surface": "#121820",
  "--surface-elevated": "#18212c",
  "--surface-muted": "#232f3d",
  "--text-primary": "#e8edf5",
  "--text-secondary": "#c0c9d7",
  "--text-muted": "#96a3b5",
  "--border": "#334153",
  "--accent": "#5caedf",
  "--accent-soft": "#22384d",
  "--accent-contrast": "#07121e",
  "--success": "#2bd08a",
  "--danger": "#ff6a7f",
  "--header-bg": "rgba(19, 27, 38, 0.8)",
  "--page-gradient":
    "radial-gradient(circle at 10% 2%, #273448 0%, transparent 32%), radial-gradient(circle at 88% 6%, #1f3445 0%, transparent 30%), linear-gradient(180deg, #0d141f 0%, #111a28 50%, #0c141f 100%)",
};

const LIGHT_DEFAULT_ACCENT = LIGHT_THEME_BASE_VARIABLES["--accent"];
const DARK_DEFAULT_ACCENT = DARK_THEME_BASE_VARIABLES["--accent"];
const LIGHT_CONTRAST = "#f8fbff";
const DARK_CONTRAST = "#07121e";

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
  lightAccent: LIGHT_DEFAULT_ACCENT,
  darkAccent: DARK_DEFAULT_ACCENT,
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
    lightAccent: normalizeAccentColor(source.lightAccent, fallback.lightAccent),
    darkAccent: normalizeAccentColor(source.darkAccent, fallback.darkAccent),
    customCss: typeof source.customCss === "string" ? source.customCss : fallback.customCss,
  };
};

export const resolveAccentColor = (settings: ThemeCustomizationSettings, mode: ThemeMode): string =>
  settings.useSharedAccent
    ? normalizeAccentColor(settings.sharedAccent, mode === "dark" ? DARK_DEFAULT_ACCENT : LIGHT_DEFAULT_ACCENT)
    : mode === "dark"
      ? normalizeAccentColor(settings.darkAccent, DARK_DEFAULT_ACCENT)
      : normalizeAccentColor(settings.lightAccent, LIGHT_DEFAULT_ACCENT);

const buildAccentSoft = (mode: ThemeMode, accent: string): string =>
  mixHexColors(mode === "dark" ? DARK_THEME_BASE_VARIABLES["--surface"] : LIGHT_THEME_BASE_VARIABLES["--surface"], accent, mode === "dark" ? 0.22 : 0.16);

const buildAccentContrast = (accent: string): string => (relativeLuminance(accent) >= 0.42 ? DARK_CONTRAST : LIGHT_CONTRAST);

export const buildThemeVariables = (mode: ThemeMode, settings: ThemeCustomizationSettings): ThemeVariables => {
  const defaults = mode === "dark" ? DARK_THEME_BASE_VARIABLES : LIGHT_THEME_BASE_VARIABLES;
  const accent = resolveAccentColor(settings, mode);

  return {
    ...defaults,
    "--accent": accent,
    "--accent-soft": buildAccentSoft(mode, accent),
    "--accent-contrast": buildAccentContrast(accent),
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
