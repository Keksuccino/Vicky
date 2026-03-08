import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeDocsCacheTtlMs } from "@/lib/cache";
import { DEFAULT_SETTINGS, DEFAULT_STORE, STORE_VERSION } from "@/lib/defaults";
import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import { normalizeFooterTemplate } from "@/lib/footer";
import { normalizeStartPage } from "@/lib/start-page";
import { DEFAULT_THEME_CUSTOMIZATION, normalizeAccentColor, normalizeThemeCustomization } from "@/lib/theme";
import type { AppSettings, DocsStore } from "@/lib/types";

const DEFAULT_STORE_PATH = path.join(process.cwd(), "data", "wiki-store.json");
const STORE_PATH = process.env.WIKI_STORE_FILE_PATH ?? DEFAULT_STORE_PATH;

const now = (): string => new Date().toISOString();

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
  const fallbackTheme = sourceTheme ? defaults.theme : deriveThemeCustomizationFromLegacyStore(source, legacyThemes);

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
    docsCacheTtlMs: normalizeDocsCacheTtlMs(source.docsCacheTtlMs, defaults.docsCacheTtlMs),
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
  };
};

const writeStoreFile = async (store: DocsStore): Promise<void> => {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await rename(tempPath, STORE_PATH);
};

const readStoreFile = async (): Promise<unknown> => {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
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

export const getStore = async (): Promise<DocsStore> => {
  const raw = await readStoreFile();
  const normalized = normalizeStore(raw);

  const rawText = JSON.stringify(raw);
  const normalizedText = JSON.stringify(normalized);

  if (rawText !== normalizedText) {
    await writeStoreFile(normalized);
  }

  return normalized;
};

export const saveStore = async (store: DocsStore): Promise<DocsStore> => {
  const normalized = normalizeStore(store);
  await writeStoreFile(normalized);
  return normalized;
};

export const updateStore = async (mutator: (store: DocsStore) => void | Promise<void>): Promise<DocsStore> =>
  enqueueMutation(async () => {
    const current = await getStore();
    const next = structuredClone(current);
    await mutator(next);

    next.version = STORE_VERSION;
    next.settings.updatedAt = now();

    return saveStore(next);
  });

export const getPublicSettings = (settings: AppSettings): Omit<AppSettings, "github"> & {
  github: Omit<AppSettings["github"], "tokenEncrypted"> & { tokenConfigured: boolean };
} => ({
  ...settings,
  github: {
    owner: settings.github.owner,
    repo: settings.github.repo,
    branch: settings.github.branch,
    docsPath: settings.github.docsPath,
    tokenConfigured: Boolean(settings.github.tokenEncrypted),
  },
});
