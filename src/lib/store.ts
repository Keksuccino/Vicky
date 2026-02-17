import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeDocsCacheTtlMs } from "@/lib/cache";
import { BUILTIN_THEME_IDS, DEFAULT_SETTINGS, DEFAULT_STORE, DEFAULT_THEMES, STORE_VERSION } from "@/lib/defaults";
import { normalizeStartPage } from "@/lib/start-page";
import type { AppSettings, DocsStore, ThemeDefinition, ThemeVariables } from "@/lib/types";

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

const normalizeThemeVariables = (variables: unknown, fallback: ThemeVariables): ThemeVariables => {
  const source = typeof variables === "object" && variables !== null ? (variables as Record<string, unknown>) : {};
  const entries = Object.entries(source)
    .map(([rawKey, rawValue]) => {
      if (typeof rawValue !== "string") {
        return null;
      }

      const key = rawKey.trim();
      const value = rawValue.trim();
      if (!key || !value) {
        return null;
      }

      const normalizedKey = key.startsWith("--") ? key : `--${key}`;
      return [normalizedKey, value] as const;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  if (entries.length === 0) {
    return { ...fallback };
  }

  return Object.fromEntries(entries);
};

const normalizeTheme = (value: unknown, fallback?: ThemeDefinition): ThemeDefinition | null => {
  if (typeof value !== "object" || value === null) {
    return fallback ?? null;
  }

  const source = value as Record<string, unknown>;
  const reference = fallback;

  const id = normalizeString(source.id, reference?.id ?? "");
  const name = normalizeString(source.name, reference?.name ?? "");
  const mode = source.mode === "dark" ? "dark" : source.mode === "light" ? "light" : reference?.mode;

  if (!id || !name || !mode) {
    return fallback ?? null;
  }

  const createdAt = normalizeString(source.createdAt, reference?.createdAt ?? now());
  const updatedAt = normalizeString(source.updatedAt, reference?.updatedAt ?? createdAt);
  const isBuiltin = typeof source.isBuiltin === "boolean" ? source.isBuiltin : reference?.isBuiltin ?? false;

  const variableSource = source.variables ?? source.tokens;
  const baseVariables = reference?.variables ?? DEFAULT_THEMES()[0].variables;
  const variables = normalizeThemeVariables(variableSource, baseVariables);
  const customCss = typeof source.customCss === "string" ? source.customCss : reference?.customCss ?? "";

  return {
    id,
    name,
    mode,
    isBuiltin,
    createdAt,
    updatedAt,
    variables,
    customCss,
  };
};

const normalizeThemes = (value: unknown): ThemeDefinition[] => {
  const defaults = DEFAULT_THEMES();
  const builtinMap = new Map(defaults.map((theme) => [theme.id, theme]));

  const sourceThemes = Array.isArray(value) ? value : [];
  const normalized = new Map<string, ThemeDefinition>();

  for (const defaultTheme of defaults) {
    normalized.set(defaultTheme.id, defaultTheme);
  }

  for (const themeValue of sourceThemes) {
    const parsed = normalizeTheme(themeValue);
    if (!parsed) {
      continue;
    }

    if (builtinMap.has(parsed.id)) {
      const builtinFallback = builtinMap.get(parsed.id);
      const builtinTheme = normalizeTheme(parsed, builtinFallback);
      if (builtinTheme && builtinFallback) {
        builtinTheme.isBuiltin = true;
        builtinTheme.mode = builtinFallback.mode;
        builtinTheme.name = builtinFallback.name;
        // Built-in themes are versioned with the app; keep their default tokens current.
        builtinTheme.variables = {
          ...builtinTheme.variables,
          ...builtinFallback.variables,
        };
        normalized.set(parsed.id, builtinTheme);
      }
      continue;
    }

    normalized.set(parsed.id, {
      ...parsed,
      isBuiltin: false,
      createdAt: parsed.createdAt || now(),
      updatedAt: parsed.updatedAt || parsed.createdAt || now(),
    });
  }

  return [...normalized.values()];
};

const normalizeSettings = (value: unknown, themes: ThemeDefinition[]): AppSettings => {
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

  const settings: AppSettings = {
    siteTitle: normalizeString(source.siteTitle, defaults.siteTitle),
    siteDescription: normalizeString(source.siteDescription, defaults.siteDescription),
    footerText: normalizeTrimmedString(source.footerText, defaults.footerText),
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
    github: {
      owner: normalizeString(sourceGitHub.owner, defaults.github.owner),
      repo: normalizeString(sourceGitHub.repo, defaults.github.repo),
      branch: normalizeString(sourceGitHub.branch, defaults.github.branch),
      docsPath: normalizeString(sourceGitHub.docsPath, defaults.github.docsPath),
      tokenEncrypted: normalizeOptionalString(sourceGitHub.tokenEncrypted),
    },
    activeThemeId: normalizeString(source.activeThemeId, defaults.activeThemeId),
    updatedAt: normalizeString(source.updatedAt, defaults.updatedAt),
  };

  const themeExists = themes.some((theme) => theme.id === settings.activeThemeId);
  if (!themeExists) {
    settings.activeThemeId = BUILTIN_THEME_IDS.light;
  }

  return settings;
};

const normalizeStore = (value: unknown): DocsStore => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const themes = normalizeThemes(source.themes);
  const settings = normalizeSettings(source.settings, themes);

  return {
    version: STORE_VERSION,
    settings,
    themes,
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
