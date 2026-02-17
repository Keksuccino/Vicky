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
  "--accent-soft": "#d6ecff",
  "--accent-contrast": "#f8fbff",
  "--success": "#0f8a58",
  "--danger": "#ca3f54",
  "--header-bg": "rgba(248, 251, 255, 0.88)",
  "--page-gradient":
    "radial-gradient(circle at 12% 0%, #e3f1ff 0%, transparent 35%), radial-gradient(circle at 88% 8%, #d8eaff 0%, transparent 25%), linear-gradient(180deg, #eff6ff 0%, #f6faff 45%, #edf4ff 100%)",
};

const darkVariables = {
  "--surface": "#0f1828",
  "--surface-elevated": "#152238",
  "--surface-muted": "#1d2e4a",
  "--text-primary": "#edf4ff",
  "--text-secondary": "#bfd0eb",
  "--text-muted": "#9cb0cf",
  "--border": "#2a4061",
  "--accent": "#53b5ff",
  "--accent-soft": "#173a5d",
  "--accent-contrast": "#031324",
  "--success": "#2bd08a",
  "--danger": "#ff6a7f",
  "--header-bg": "rgba(14, 24, 41, 0.8)",
  "--page-gradient":
    "radial-gradient(circle at 10% 2%, #1c2f50 0%, transparent 32%), radial-gradient(circle at 88% 6%, #123b54 0%, transparent 30%), linear-gradient(180deg, #0a1526 0%, #0d1b30 50%, #091426 100%)",
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
  siteTitleGradient: {
    from: "",
    to: "",
  },
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
