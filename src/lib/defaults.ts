import { DOCS_CACHE_TTL_MS } from "@/lib/cache";
import { DEFAULT_START_PAGE } from "@/lib/start-page";
import type { AppSettings, DocsStore, ThemeDefinition } from "@/lib/types";

export const STORE_VERSION = 1 as const;

export const BUILTIN_THEME_IDS = {
  light: "builtin-light",
  dark: "builtin-dark",
} as const;

const now = (): string => new Date().toISOString();

const lightVariables = {
  "--surface": "#f8fbff",
  "--surface-elevated": "#ffffff",
  "--surface-muted": "#e9f1ff",
  "--text-primary": "#111b2e",
  "--text-secondary": "#334869",
  "--text-muted": "#5f7393",
  "--border": "#d6e2f2",
  "--accent": "#006ecf",
  "--accent-alt": "#2b6dff",
  "--accent-soft": "#d6ecff",
  "--accent-contrast": "#f8fbff",
  "--accent-gradient": "linear-gradient(136deg, #006ecf 0%, #2b6dff 100%)",
  "--panel-gradient": "var(--surface-elevated)",
  "--panel-highlight": "0 0 0 1px transparent",
  "--success": "#0f8a58",
  "--danger": "#ca3f54",
  "--header-bg": "rgba(248, 251, 255, 0.88)",
  "--page-gradient":
    "radial-gradient(circle at 12% 0%, #e3f1ff 0%, transparent 35%), radial-gradient(circle at 88% 8%, #d8eaff 0%, transparent 25%), linear-gradient(180deg, #eff6ff 0%, #f6faff 45%, #edf4ff 100%)",
  "--page-gradient-size": "auto",
};

const darkVariables = {
  "--surface": "#04050b",
  "--surface-elevated": "#0d111c",
  "--surface-muted": "#131a2b",
  "--text-primary": "#f3f5ff",
  "--text-secondary": "#c2c9df",
  "--text-muted": "#8e97b2",
  "--border": "#202b44",
  "--accent": "#5f7dff",
  "--accent-alt": "#f216a3",
  "--accent-soft": "#1a2342",
  "--accent-contrast": "#f6f8ff",
  "--accent-gradient": "linear-gradient(136deg, #4d78ff 0%, #6a53ff 48%, #f216a3 100%)",
  "--panel-gradient": "linear-gradient(180deg, rgba(17, 23, 40, 0.9) 0%, rgba(10, 14, 25, 0.95) 100%)",
  "--panel-highlight": "0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent)",
  "--success": "#2ad89e",
  "--danger": "#ff5b8c",
  "--header-bg": "rgba(3, 6, 12, 0.82)",
  "--page-gradient":
    "repeating-linear-gradient(60deg, transparent 0 62px, rgb(120 135 180 / 15%) 62px 64px, transparent 64px 126px), repeating-linear-gradient(-60deg, transparent 0 62px, rgb(120 135 180 / 15%) 62px 64px, transparent 64px 126px), repeating-linear-gradient(0deg, transparent 0 35px, rgb(120 135 180 / 15%) 35px 37px, transparent 37px 74px), radial-gradient(circle at 25% 8%, rgb(83 104 255 / 42%) 0%, transparent 38%), radial-gradient(circle at 69% 15%, rgb(242 22 163 / 35%) 0%, transparent 34%), linear-gradient(180deg, #020307 0%, #04060c 50%, #020307 100%)",
  "--page-gradient-size": "164px 284px, 164px 284px, 164px 284px, auto, auto, auto",
};

export const DEFAULT_THEMES = (): ThemeDefinition[] => {
  const timestamp = now();

  return [
    {
      id: BUILTIN_THEME_IDS.light,
      name: "Classic Light",
      mode: "light",
      isBuiltin: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      variables: lightVariables,
      customCss: "",
    },
    {
      id: BUILTIN_THEME_IDS.dark,
      name: "Classic Dark",
      mode: "dark",
      isBuiltin: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      variables: darkVariables,
      customCss: "",
    },
  ];
};

export const DEFAULT_SETTINGS = (): AppSettings => ({
  siteTitle: "Vicky Docs",
  siteDescription: "Documentation knowledge base",
  startPage: DEFAULT_START_PAGE,
  docsIcon: {
    png16Url: "",
    png32Url: "",
    png180Url: "",
  },
  docsCacheTtlMs: DOCS_CACHE_TTL_MS,
  github: {
    owner: "",
    repo: "",
    branch: "main",
    docsPath: "docs",
    tokenEncrypted: null,
  },
  activeThemeId: BUILTIN_THEME_IDS.light,
  updatedAt: now(),
});

export const DEFAULT_STORE = (): DocsStore => ({
  version: STORE_VERSION,
  settings: DEFAULT_SETTINGS(),
  themes: DEFAULT_THEMES(),
});
