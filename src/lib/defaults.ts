import { DOCS_CACHE_TTL_MS } from "@/lib/cache";
import { DEFAULT_START_PAGE } from "@/lib/start-page";
import { DEFAULT_THEME_CUSTOMIZATION } from "@/lib/theme";
import type { AppSettings, DocsStore } from "@/lib/types";

export const STORE_VERSION = 2 as const;

const now = (): string => new Date().toISOString();

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
  domain: {
    customDomain: "",
    letsEncryptEmail: "",
  },
  github: {
    owner: "",
    repo: "",
    branch: "main",
    docsPath: "docs",
    tokenEncrypted: null,
  },
  theme: DEFAULT_THEME_CUSTOMIZATION(),
  updatedAt: now(),
});

export const DEFAULT_STORE = (): DocsStore => ({
  version: STORE_VERSION,
  settings: DEFAULT_SETTINGS(),
});
