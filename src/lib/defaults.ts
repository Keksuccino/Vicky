import { randomUUID } from "node:crypto";

import { DEFAULT_AUTO_TRANSLATE_SETTINGS, DEFAULT_OPENROUTER_SETTINGS } from "@/lib/auto-translate";
import { DEFAULT_AI_CHAT_SETTINGS } from "@/lib/ai-chat";
import { DOCS_CACHE_TTL_MS } from "@/lib/cache";
import { DEFAULT_FOOTER_TEXT } from "@/lib/footer";
import { DEFAULT_START_PAGE } from "@/lib/start-page";
import { DEFAULT_THEME_CUSTOMIZATION } from "@/lib/theme";
import type { AppSettings, DocsStore, VisitorStatsStore } from "@/lib/types";

export const STORE_VERSION = 11 as const;

const now = (): string => new Date().toISOString();

export const DEFAULT_VISITOR_STATS = (): VisitorStatsStore => ({
  salt: randomUUID(),
  updatedAt: now(),
  visits: [],
});

export const DEFAULT_SETTINGS = (): AppSettings => ({
  siteTitle: "Vicky Docs",
  siteDescription: "Documentation knowledge base",
  footerText: DEFAULT_FOOTER_TEXT,
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
  openRouter: DEFAULT_OPENROUTER_SETTINGS(),
  aiChat: DEFAULT_AI_CHAT_SETTINGS(),
  autoTranslate: DEFAULT_AUTO_TRANSLATE_SETTINGS(),
  theme: DEFAULT_THEME_CUSTOMIZATION(),
  updatedAt: now(),
});

export const DEFAULT_STORE = (): DocsStore => ({
  version: STORE_VERSION,
  settings: DEFAULT_SETTINGS(),
  moderators: [],
});
