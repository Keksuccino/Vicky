import { readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { normalizeAutoTranslateSettings } from "@/lib/auto-translate";
import {
  DEFAULT_AI_CHAT_SETTINGS,
  normalizeAiAssistantName,
  normalizeAiChatAvatarUrl,
  normalizeAiChatHeaderSubtitle,
  normalizeAiChatSystemPromptTemplate,
  normalizeAiChatWelcomeMessage,
} from "@/lib/ai-chat";
import { normalizeDocsCacheTtlMs } from "@/lib/cache";
import { DEFAULT_SETTINGS, DEFAULT_STORE, STORE_VERSION } from "@/lib/defaults";
import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import { normalizeFooterTemplate } from "@/lib/footer";
import { createGitHubCacheEpoch, normalizeGitHubCacheEpoch } from "@/lib/github-cache-identity";
import { cleanupLegacyGitHubLogicalSourceCaches } from "@/lib/github-legacy-cache-cleanup";
import { ensurePrivateFile, openPrivateFileExclusive, secureAtomicWriteFile } from "@/lib/runtime-file-security.mjs";
import { normalizeStartPage } from "@/lib/start-page";
import { DEFAULT_THEME_CUSTOMIZATION, normalizeAccentColor, normalizeThemeCustomization } from "@/lib/theme";
import type {
  AppSettings,
  DocsStore,
  ModeratorAccount,
} from "@/lib/types";

const DEFAULT_STORE_PATH = path.join(process.cwd(), "data", "wiki-store.json");
const STORE_PATH = process.env.WIKI_STORE_FILE_PATH ?? DEFAULT_STORE_PATH;
const STORE_LOCK_PATH = `${STORE_PATH}.lock`;
const STORE_LOCK_RETRY_MS = 250;
const STORE_LOCK_STALE_MS = 15_000;
const STORE_READ_CACHE_TTL_MS = 1_000;

const now = (): string => new Date().toISOString();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const cloneStore = (store: DocsStore): DocsStore => structuredClone(store);

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
  const sourceOpenRouter =
    typeof source.openRouter === "object" && source.openRouter !== null
      ? (source.openRouter as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const fallbackTheme = sourceTheme ? defaults.theme : deriveThemeCustomizationFromLegacyStore(source, legacyThemes);
  const defaultAiChat = DEFAULT_AI_CHAT_SETTINGS();
  const assistantName = normalizeAiAssistantName(sourceAiChat.assistantName, defaultAiChat.assistantName);
  const avatarUrl = normalizeAiChatAvatarUrl(sourceAiChat.avatarUrl);
  const headerSubtitle = normalizeAiChatHeaderSubtitle(sourceAiChat.headerSubtitle, defaultAiChat.headerSubtitle);
  const welcomeMessage = normalizeAiChatWelcomeMessage(sourceAiChat.welcomeMessage, defaultAiChat.welcomeMessage);
  const legacyOpenRouterApiKeyEncrypted = normalizeOptionalString(sourceAiChat.openRouterApiKeyEncrypted);

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
      cacheEpoch: normalizeGitHubCacheEpoch(sourceGitHub.cacheEpoch),
    },
    openRouter: {
      apiKeyEncrypted: normalizeOptionalString(sourceOpenRouter.apiKeyEncrypted) ?? legacyOpenRouterApiKeyEncrypted,
    },
    aiChat: {
      enabled: typeof sourceAiChat.enabled === "boolean" ? sourceAiChat.enabled : defaultAiChat.enabled,
      assistantName,
      avatarUrl,
      headerSubtitle,
      welcomeMessage,
      openRouterModel: normalizeString(sourceAiChat.openRouterModel, defaultAiChat.openRouterModel),
      systemPrompt: normalizeAiChatSystemPromptTemplate(sourceAiChat.systemPrompt),
    },
    autoTranslate: normalizeAutoTranslateSettings(source.autoTranslate),
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
  };
};

const writeStoreFile = async (store: DocsStore): Promise<void> => {
  await secureAtomicWriteFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
};

const readLockContent = async (): Promise<string | null> => {
  try {
    return await readFile(STORE_LOCK_PATH, "utf8");
  } catch {
    return null;
  }
};

const readLockPid = async (): Promise<number | null> => {
  const content = await readLockContent();
  if (!content) {
    return null;
  }

  try {
    const rawPid = content.split(":")[0]?.trim();
    const pid = rawPid ? Number.parseInt(rawPid, 10) : Number.NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const shouldRemoveExistingLock = async (lockMtimeMs: number): Promise<boolean> => {
  if (Date.now() - lockMtimeMs > STORE_LOCK_STALE_MS) {
    return true;
  }

  const lockPid = await readLockPid();
  return Boolean(lockPid && !isProcessAlive(lockPid));
};

const acquireStoreLock = async (): Promise<() => Promise<void>> => {
  for (;;) {
    try {
      const handle = await openPrivateFileExclusive(STORE_LOCK_PATH);
      const lockContent = `${process.pid}:${Date.now()}:${randomUUID()}`;
      try {
        await handle.writeFile(lockContent, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(STORE_LOCK_PATH, { force: true }).catch(() => undefined);
        throw error;
      }

      return async () => {
        await handle.close();
        if ((await readLockContent()) === lockContent) {
          await rm(STORE_LOCK_PATH, { force: true });
        }
      };
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }

      try {
        await ensurePrivateFile(STORE_LOCK_PATH);
        const lockStat = await stat(STORE_LOCK_PATH);
        if (await shouldRemoveExistingLock(lockStat.mtimeMs)) {
          await rm(STORE_LOCK_PATH, { force: true });
          continue;
        }
      } catch (lockError: unknown) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw lockError;
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
    await ensurePrivateFile(STORE_PATH);
    // The settings store contains mutable encrypted runtime data and may live outside the project; it must not be traced into builds.
    const raw = await readFile(/*turbopackIgnore: true*/ STORE_PATH, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return DEFAULT_STORE();
    }
    throw error;
  }
};

let mutationQueue: Promise<unknown> = Promise.resolve();
let cachedStore: { store: DocsStore; expiresAtMs: number } | null = null;

const enqueueMutation = <T>(work: () => Promise<T>): Promise<T> => {
  const result = mutationQueue.then(work, work);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
};

export const getStorePath = (): string => STORE_PATH;

const getCachedStore = (): DocsStore | null => {
  if (!cachedStore || cachedStore.expiresAtMs <= Date.now()) {
    cachedStore = null;
    return null;
  }

  return cloneStore(cachedStore.store);
};

const updateCachedStore = (store: DocsStore): void => {
  cachedStore = {
    store: cloneStore(store),
    expiresAtMs: Date.now() + STORE_READ_CACHE_TTL_MS,
  };
};

type StoreReadResult = {
  requiresLegacyCacheMigration: boolean;
  store: DocsStore;
};

const readStoreFresh = async (): Promise<StoreReadResult> => {
  const raw = await readStoreFile();
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const settings = typeof source.settings === "object" && source.settings !== null ? (source.settings as Record<string, unknown>) : {};
  const github = typeof settings.github === "object" && settings.github !== null ? (settings.github as Record<string, unknown>) : {};
  const hasCacheEpoch = typeof github.cacheEpoch === "string" && Boolean(github.cacheEpoch.trim());
  const storedVersion = typeof source.version === "number" ? source.version : 0;

  return {
    requiresLegacyCacheMigration: storedVersion < STORE_VERSION || !hasCacheEpoch,
    store: normalizeStore(raw),
  };
};

/**
 * Pre-v12 cache entries contain no credential identity. Delete their exact
 * logical-source formats before publishing a fresh epoch, so an interrupted
 * migration retries cleanup instead of marking legacy artifacts as migrated.
 */
const migrateLegacyCacheEpochUnlocked = async (read: StoreReadResult): Promise<DocsStore> => {
  if (!read.requiresLegacyCacheMigration) {
    return read.store;
  }

  const next = cloneStore(read.store);
  await cleanupLegacyGitHubLogicalSourceCaches({ ...next.settings.github, token: "" });
  next.settings.github.cacheEpoch = createGitHubCacheEpoch();
  next.version = STORE_VERSION;
  await writeStoreFile(next);
  return next;
};

const getStoreUnlocked = async (): Promise<DocsStore> => {
  const cached = getCachedStore();
  if (cached) {
    return cached;
  }

  const initialRead = await readStoreFresh();
  if (!initialRead.requiresLegacyCacheMigration) {
    updateCachedStore(initialRead.store);
    return cloneStore(initialRead.store);
  }

  const normalized = await withStoreLock(async () => migrateLegacyCacheEpochUnlocked(await readStoreFresh()));
  updateCachedStore(normalized);
  return cloneStore(normalized);
};

export const getStore = async (): Promise<DocsStore> => getStoreUnlocked();

const saveStoreUnlocked = async (store: DocsStore): Promise<DocsStore> => {
  const normalized = normalizeStore(store);
  await writeStoreFile(normalized);
  updateCachedStore(normalized);
  return cloneStore(normalized);
};

export const saveStore = async (store: DocsStore): Promise<DocsStore> => withStoreLock(() => saveStoreUnlocked(store));

export const updateStore = async (
  mutator: (store: DocsStore) => boolean | void | Promise<boolean | void>,
  options?: { touchSettings?: boolean },
): Promise<DocsStore> =>
  enqueueMutation(async () => {
    return withStoreLock(async () => {
      const current = await migrateLegacyCacheEpochUnlocked(await readStoreFresh());
      const next = structuredClone(current);
      const result = await mutator(next);

      if (result === false) {
        updateCachedStore(current);
        return cloneStore(current);
      }

      next.version = STORE_VERSION;
      if (options?.touchSettings !== false) {
        next.settings.updatedAt = now();
      }

      return saveStoreUnlocked(next);
    });
  });

export const getPublicSettings = (settings: AppSettings): Omit<AppSettings, "github" | "openRouter"> & {
  github: Omit<AppSettings["github"], "tokenEncrypted" | "cacheEpoch"> & { tokenConfigured: boolean };
  openRouter: { apiKeyConfigured: boolean };
} => ({
  ...settings,
  github: {
    owner: settings.github.owner,
    repo: settings.github.repo,
    branch: settings.github.branch,
    docsPath: settings.github.docsPath,
    tokenConfigured: Boolean(settings.github.tokenEncrypted),
  },
  openRouter: {
    apiKeyConfigured: Boolean(settings.openRouter.apiKeyEncrypted),
  },
  aiChat: {
    enabled: settings.aiChat.enabled,
    assistantName: settings.aiChat.assistantName,
    avatarUrl: settings.aiChat.avatarUrl,
    headerSubtitle: settings.aiChat.headerSubtitle,
    welcomeMessage: settings.aiChat.welcomeMessage,
    openRouterModel: settings.aiChat.openRouterModel,
    systemPrompt: settings.aiChat.systemPrompt,
  },
});
