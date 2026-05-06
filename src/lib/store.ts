import { readFileSync } from "node:fs";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  DEFAULT_AI_CHAT_SETTINGS,
  normalizeAiAssistantName,
  normalizeAiChatAvatarUrl,
  normalizeAiChatHeaderSubtitle,
  normalizeAiChatSystemPromptTemplate,
  normalizeAiChatWelcomeMessage,
} from "@/lib/ai-chat";
import { normalizeDocsCacheTtlMs } from "@/lib/cache";
import { DEFAULT_SETTINGS, DEFAULT_STORE, DEFAULT_VISITOR_STATS, STORE_VERSION } from "@/lib/defaults";
import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import { normalizeFooterTemplate } from "@/lib/footer";
import { normalizeStartPage } from "@/lib/start-page";
import { DEFAULT_THEME_CUSTOMIZATION, normalizeAccentColor, normalizeThemeCustomization } from "@/lib/theme";
import type {
  AppSettings,
  DocsStore,
  ModeratorAccount,
  VisitorStatsBucket,
  VisitorStatsPageBucket,
  VisitorStatsStore,
} from "@/lib/types";

const DEFAULT_STORE_PATH = path.join(process.cwd(), "data", "wiki-store.json");
const STORE_PATH = process.env.WIKI_STORE_FILE_PATH ?? DEFAULT_STORE_PATH;
const STORE_LOCK_PATH = `${STORE_PATH}.lock`;
const STORE_LOCK_RETRY_MS = 25;
const STORE_LOCK_STALE_MS = 300_000;

const now = (): string => new Date().toISOString();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeString = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const normalizeTrimmedString = (value: unknown, fallback = ""): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim();
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeTimestamp = (value: unknown): string => {
  if (typeof value !== "string") {
    return now();
  }

  const trimmed = value.trim();
  return Number.isNaN(Date.parse(trimmed)) ? now() : trimmed;
};

const normalizeStoredDocsRefreshIntervalMs = (value: unknown, fallback: number): number => {
  const normalized = normalizeDocsCacheTtlMs(value, fallback);
  const numericValue =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;

  if (Number.isFinite(numericValue) && numericValue > 0 && numericValue < 60_000) {
    return fallback;
  }

  return normalized;
};

const normalizeModeratorUsername = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
};

const MODERATOR_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

const normalizeModerator = (value: unknown): ModeratorAccount | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const username = normalizeModeratorUsername(source.username);
  const passwordHash = normalizeTrimmedString(source.passwordHash);

  if (!MODERATOR_USERNAME_PATTERN.test(username) || username === "admin" || !passwordHash) {
    return null;
  }

  const createdAt = normalizeTimestamp(source.createdAt);

  return {
    id: normalizeTrimmedString(source.id) || randomUUID(),
    username,
    passwordHash,
    createdAt,
    updatedAt: normalizeTimestamp(source.updatedAt) || createdAt,
  };
};

const normalizeModerators = (value: unknown): ModeratorAccount[] => {
  const seenUsernames = new Set<string>();
  return (Array.isArray(value) ? value : [])
    .map((entry) => normalizeModerator(entry))
    .filter((entry): entry is ModeratorAccount => {
      if (!entry || seenUsernames.has(entry.username)) {
        return false;
      }

      seenUsernames.add(entry.username);
      return true;
    });
};

const normalizeVisitorId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeVisitorIds = (value: unknown): string[] => {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const entry of Array.isArray(value) ? value : []) {
    const id = normalizeVisitorId(entry);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
};

const normalizeNonNegativeInteger = (value: unknown, fallback = 0): number => {
  const numericValue =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;

  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return fallback;
  }

  return Math.round(numericValue);
};

const normalizeVisitorStatsSlug = (value: unknown, fallback = ""): string => {
  const rawValue = typeof value === "string" ? value : fallback;

  return rawValue
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/?docs\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.(md|mdx)$/i, "")
    .replace(/\/+/g, "/");
};

const visitorStatsPathFromSlug = (slug: string): string => (slug ? `/${slug}` : "/");

const prettyVisitorStatsTitle = (slug: string): string => {
  const segment = slug.split("/").filter(Boolean).at(-1) ?? "Docs";
  return segment
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const normalizeVisitorStatsPageBucket = (
  value: unknown,
  fallbackKey: string,
): VisitorStatsPageBucket | null => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const slug = normalizeVisitorStatsSlug(source.slug, fallbackKey);

  if (!slug) {
    return null;
  }

  return {
    path: visitorStatsPathFromSlug(slug),
    slug,
    title: normalizeString(source.title, prettyVisitorStatsTitle(slug)),
    visits: Math.max(normalizeNonNegativeInteger(source.visits, 0), normalizeVisitorIds(source.visitorIds).length),
    visitorIds: normalizeVisitorIds(source.visitorIds),
    updatedAt: normalizeTimestamp(source.updatedAt),
  };
};

const normalizeVisitorStatsBucket = (value: unknown): VisitorStatsBucket => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const visitorIds = normalizeVisitorIds(source.visitorIds);
  const visitorIdSet = new Set(visitorIds);
  const pages: Record<string, VisitorStatsPageBucket> = {};
  let pageVisits = 0;
  const pagesSource =
    typeof source.pages === "object" && source.pages !== null ? (source.pages as Record<string, unknown>) : {};

  for (const [key, entry] of Object.entries(pagesSource)) {
    const page = normalizeVisitorStatsPageBucket(entry, key);
    if (!page || pages[page.slug]) {
      continue;
    }

    pages[page.slug] = page;
    pageVisits += page.visits;
    for (const visitorId of page.visitorIds) {
      if (!visitorIdSet.has(visitorId)) {
        visitorIdSet.add(visitorId);
        visitorIds.push(visitorId);
      }
    }
  }

  return {
    visits: Math.max(normalizeNonNegativeInteger(source.visits, 0), pageVisits, visitorIds.length),
    visitorIds,
    pages,
  };
};

const normalizeVisitorStatsBucketMap = (value: unknown): Record<string, VisitorStatsBucket> => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const buckets: Record<string, VisitorStatsBucket> = {};

  for (const [key, entry] of Object.entries(source)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }

    buckets[normalizedKey] = normalizeVisitorStatsBucket(entry);
  }

  return buckets;
};

const normalizeVisitorStats = (value: unknown): VisitorStatsStore => {
  const defaults = DEFAULT_VISITOR_STATS();
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  return {
    salt: normalizeString(source.salt, defaults.salt),
    updatedAt: normalizeTimestamp(source.updatedAt),
    allTime: normalizeVisitorStatsBucket(source.allTime),
    daily: normalizeVisitorStatsBucketMap(source.daily),
    weekly: normalizeVisitorStatsBucketMap(source.weekly),
    monthly: normalizeVisitorStatsBucketMap(source.monthly),
    yearly: normalizeVisitorStatsBucketMap(source.yearly),
  };
};

const normalizeThemeAccentValue = (variables: unknown): string | null => {
  const source = typeof variables === "object" && variables !== null ? (variables as Record<string, unknown>) : {};
  const rawAccent = source["--accent"] ?? source.accent;
  return typeof rawAccent === "string" && rawAccent.trim() ? rawAccent.trim() : null;
};

type LegacyTheme = {
  id: string;
  mode: "light" | "dark";
  isBuiltin: boolean;
  accent: string | null;
  customCss: string;
};

const normalizeLegacyTheme = (value: unknown): LegacyTheme | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const id = normalizeString(source.id, "");
  const mode = source.mode === "dark" ? "dark" : source.mode === "light" ? "light" : null;
  if (!id || !mode) {
    return null;
  }

  return {
    id,
    mode,
    isBuiltin: typeof source.isBuiltin === "boolean" ? source.isBuiltin : false,
    accent: normalizeThemeAccentValue(source.variables ?? source.tokens),
    customCss: typeof source.customCss === "string" ? source.customCss : "",
  };
};

const normalizeLegacyThemes = (value: unknown): LegacyTheme[] =>
  (Array.isArray(value) ? value : [])
    .map((entry) => normalizeLegacyTheme(entry))
    .filter((entry): entry is LegacyTheme => Boolean(entry));

const deriveThemeCustomizationFromLegacyStore = (
  settingsSource: Record<string, unknown>,
  legacyThemes: LegacyTheme[],
): AppSettings["theme"] => {
  const defaults = DEFAULT_THEME_CUSTOMIZATION();
  const activeThemeId = normalizeOptionalString(settingsSource.activeThemeId);
  const activeTheme = activeThemeId ? legacyThemes.find((theme) => theme.id === activeThemeId) ?? null : null;
  const builtinLightTheme = legacyThemes.find((theme) => theme.isBuiltin && theme.mode === "light") ?? null;
  const builtinDarkTheme = legacyThemes.find((theme) => theme.isBuiltin && theme.mode === "dark") ?? null;

  const lightAccentSource = activeTheme?.mode === "light" ? activeTheme.accent : builtinLightTheme?.accent;
  const darkAccentSource = activeTheme?.mode === "dark" ? activeTheme.accent : builtinDarkTheme?.accent;
  const customCssSource =
    activeTheme?.customCss.trim() ||
    builtinLightTheme?.customCss.trim() ||
    builtinDarkTheme?.customCss.trim() ||
    defaults.customCss;

  return {
    lightAccent: normalizeAccentColor(lightAccentSource, defaults.lightAccent),
    lightSurfaceAccent: defaults.lightSurfaceAccent,
    darkAccent: normalizeAccentColor(darkAccentSource, defaults.darkAccent),
    darkSurfaceAccent: defaults.darkSurfaceAccent,
    customCss: customCssSource,
  };
};

const normalizeSettings = (value: unknown, legacyThemes: LegacyTheme[]): AppSettings => {
  const defaults = DEFAULT_SETTINGS();
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const sourceGitHub =
    typeof source.github === "object" && source.github !== null
      ? (source.github as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const sourceDocsIcon =
    typeof source.docsIcon === "object" && source.docsIcon !== null
      ? (source.docsIcon as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const sourceSiteTitleGradient =
    typeof source.siteTitleGradient === "object" && source.siteTitleGradient !== null
      ? (source.siteTitleGradient as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const sourceDomain =
    typeof source.domain === "object" && source.domain !== null
      ? (source.domain as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const sourceTheme =
    typeof source.theme === "object" && source.theme !== null
      ? (source.theme as Record<string, unknown>)
      : typeof source.themeCustomization === "object" && source.themeCustomization !== null
        ? (source.themeCustomization as Record<string, unknown>)
        : null;
  const sourceAiChat =
    typeof source.aiChat === "object" && source.aiChat !== null
      ? (source.aiChat as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const fallbackTheme = sourceTheme ? defaults.theme : deriveThemeCustomizationFromLegacyStore(source, legacyThemes);
  const defaultAiChat = DEFAULT_AI_CHAT_SETTINGS();
  const assistantName = normalizeAiAssistantName(sourceAiChat.assistantName, defaultAiChat.assistantName);
  const avatarUrl = normalizeAiChatAvatarUrl(sourceAiChat.avatarUrl);
  const headerSubtitle = normalizeAiChatHeaderSubtitle(sourceAiChat.headerSubtitle, defaultAiChat.headerSubtitle);
  const welcomeMessage = normalizeAiChatWelcomeMessage(sourceAiChat.welcomeMessage, defaultAiChat.welcomeMessage);

  const settings: AppSettings = {
    siteTitle: normalizeString(source.siteTitle, defaults.siteTitle),
    siteDescription: normalizeString(source.siteDescription, defaults.siteDescription),
    footerText: normalizeFooterTemplate(normalizeTrimmedString(source.footerText, defaults.footerText)),
    startPage: normalizeStartPage(source.startPage),
    siteTitleGradient: {
      from: normalizeTrimmedString(sourceSiteTitleGradient.from, defaults.siteTitleGradient.from),
      to: normalizeTrimmedString(sourceSiteTitleGradient.to, defaults.siteTitleGradient.to),
    },
    docsIcon: {
      png16Url: normalizeString(sourceDocsIcon.png16Url, defaults.docsIcon.png16Url),
      png32Url: normalizeString(sourceDocsIcon.png32Url, defaults.docsIcon.png32Url),
      png180Url: normalizeString(sourceDocsIcon.png180Url, defaults.docsIcon.png180Url),
    },
    docsCacheTtlMs: normalizeStoredDocsRefreshIntervalMs(source.docsCacheTtlMs, defaults.docsCacheTtlMs),
    domain: {
      customDomain: normalizeCustomDomain(sourceDomain.customDomain) || defaults.domain.customDomain,
      letsEncryptEmail: normalizeLetsEncryptEmail(sourceDomain.letsEncryptEmail) || defaults.domain.letsEncryptEmail,
    },
    github: {
      owner: normalizeString(sourceGitHub.owner, defaults.github.owner),
      repo: normalizeString(sourceGitHub.repo, defaults.github.repo),
      branch: normalizeString(sourceGitHub.branch, defaults.github.branch),
      docsPath: normalizeString(sourceGitHub.docsPath, defaults.github.docsPath),
      tokenEncrypted: normalizeOptionalString(sourceGitHub.tokenEncrypted),
    },
    aiChat: {
      enabled: typeof sourceAiChat.enabled === "boolean" ? sourceAiChat.enabled : defaultAiChat.enabled,
      assistantName,
      avatarUrl,
      headerSubtitle,
      welcomeMessage,
      openRouterModel: normalizeString(sourceAiChat.openRouterModel, defaultAiChat.openRouterModel),
      openRouterApiKeyEncrypted: normalizeOptionalString(sourceAiChat.openRouterApiKeyEncrypted),
      systemPrompt: normalizeAiChatSystemPromptTemplate(sourceAiChat.systemPrompt, assistantName),
    },
    theme: normalizeThemeCustomization(sourceTheme, fallbackTheme),
    updatedAt: normalizeString(source.updatedAt, defaults.updatedAt),
  };

  return settings;
};

const normalizeStore = (value: unknown): DocsStore => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const settingsSource =
    typeof source.settings === "object" && source.settings !== null ? (source.settings as Record<string, unknown>) : {};
  const legacyThemes = normalizeLegacyThemes(source.themes);
  const settings = normalizeSettings(settingsSource, legacyThemes);

  return {
    version: STORE_VERSION,
    settings,
    moderators: normalizeModerators(source.moderators),
    visitorStats: normalizeVisitorStats(source.visitorStats),
  };
};

const writeStoreFile = async (store: DocsStore): Promise<void> => {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await rename(tempPath, STORE_PATH);
};

const acquireStoreLock = async (): Promise<() => Promise<void>> => {
  await mkdir(path.dirname(STORE_LOCK_PATH), { recursive: true });

  for (;;) {
    try {
      const handle = await open(STORE_LOCK_PATH, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}`, "utf8");

      return async () => {
        await handle.close();
        await rm(STORE_LOCK_PATH, { force: true });
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }

      try {
        const lockStat = await stat(STORE_LOCK_PATH);
        if (Date.now() - lockStat.mtimeMs > STORE_LOCK_STALE_MS) {
          await rm(STORE_LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      await sleep(STORE_LOCK_RETRY_MS);
    }
  }
};

const withStoreLock = async <T>(work: () => Promise<T>): Promise<T> => {
  const release = await acquireStoreLock();

  try {
    return await work();
  } finally {
    await release();
  }
};

const readStoreFile = async (): Promise<unknown> => {
  try {
    const raw = readFileSync(STORE_PATH, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      const defaults = DEFAULT_STORE();
      await writeStoreFile(defaults);
      return defaults;
    }
    throw error;
  }
};

let mutationQueue: Promise<unknown> = Promise.resolve();

const enqueueMutation = <T>(work: () => Promise<T>): Promise<T> => {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
};

export const getStorePath = (): string => STORE_PATH;

const getStoreUnlocked = async (): Promise<DocsStore> => {
  const raw = await readStoreFile();
  const normalized = normalizeStore(raw);

  const rawText = JSON.stringify(raw);
  const normalizedText = JSON.stringify(normalized);

  if (rawText !== normalizedText) {
    await writeStoreFile(normalized);
  }

  return normalized;
};

export const getStore = async (): Promise<DocsStore> => withStoreLock(getStoreUnlocked);

const saveStoreUnlocked = async (store: DocsStore): Promise<DocsStore> => {
  const normalized = normalizeStore(store);
  await writeStoreFile(normalized);
  return normalized;
};

export const saveStore = async (store: DocsStore): Promise<DocsStore> => withStoreLock(() => saveStoreUnlocked(store));

export const updateStore = async (
  mutator: (store: DocsStore) => boolean | void | Promise<boolean | void>,
  options?: { touchSettings?: boolean },
): Promise<DocsStore> =>
  enqueueMutation(async () => {
    return withStoreLock(async () => {
      const current = await getStoreUnlocked();
      const next = structuredClone(current);
      const result = await mutator(next);

      if (result === false) {
        return current;
      }

      next.version = STORE_VERSION;
      if (options?.touchSettings !== false) {
        next.settings.updatedAt = now();
      }

      return saveStoreUnlocked(next);
    });
  });

export const getPublicSettings = (settings: AppSettings): Omit<AppSettings, "github" | "aiChat"> & {
  github: Omit<AppSettings["github"], "tokenEncrypted"> & { tokenConfigured: boolean };
  aiChat: Omit<AppSettings["aiChat"], "openRouterApiKeyEncrypted"> & { openRouterApiKeyConfigured: boolean };
} => ({
  ...settings,
  github: {
    owner: settings.github.owner,
    repo: settings.github.repo,
    branch: settings.github.branch,
    docsPath: settings.github.docsPath,
    tokenConfigured: Boolean(settings.github.tokenEncrypted),
  },
  aiChat: {
    enabled: settings.aiChat.enabled,
    assistantName: settings.aiChat.assistantName,
    avatarUrl: settings.aiChat.avatarUrl,
    headerSubtitle: settings.aiChat.headerSubtitle,
    welcomeMessage: settings.aiChat.welcomeMessage,
    openRouterModel: settings.aiChat.openRouterModel,
    systemPrompt: settings.aiChat.systemPrompt,
    openRouterApiKeyConfigured: Boolean(settings.aiChat.openRouterApiKeyEncrypted),
  },
});
