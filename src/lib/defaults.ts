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
  "--surface": "#0f1012",
  "--surface-elevated": "#17181b",
  "--surface-muted": "#222429",
  "--text-primary": "#eceef2",
  "--text-secondary": "#c4c8d1",
  "--text-muted": "#9a9faa",
  "--border": "#32353d",
  "--accent": "#a8aebd",
  "--accent-soft": "#282b33",
  "--accent-contrast": "#0d0e11",
  "--success": "#5fb08a",
  "--danger": "#d07a85",
  "--header-bg": "rgba(16, 17, 20, 0.84)",
  "--page-gradient":
    "radial-gradient(circle at 10% 2%, #21242b 0%, transparent 32%), radial-gradient(circle at 88% 6%, #1a1d23 0%, transparent 30%), linear-gradient(180deg, #090a0c 0%, #0d0f12 50%, #090a0c 100%)",
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
  footerText: "Copyright © {{year}} {{owner}}. All rights reserved.",
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
