import {
  type AdminSettings,
  type AdminLanguageTranslationCacheStatus,
  type AiChatReply,
  type AuthUser,
  type AutoTranslateLanguage,
  type AdminTranslationRequestResult,
  type DocPage,
  type DocsRefreshResult,
  type DocSearchResult,
  type DocTreeNode,
  type DomainSslCertificateState,
  type DomainSslRuntimeStatus,
  type EditableDoc,
  type MarkdownHeading,
  type ModeratorAccount,
  type VisitorStatsPage,
  type VisitorStatsPeriod,
  type VisitorStatsScopeData,
  type VisitorStatsSummary,
} from "@/components/types";
import {
  DEFAULT_AI_CHAT_ASSISTANT_NAME,
  DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  DEFAULT_OPENROUTER_MODEL,
} from "@/lib/ai-chat";
import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  DEFAULT_AUTO_TRANSLATE_LANGUAGES,
  DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  normalizeAutoTranslateLanguage,
} from "@/lib/auto-translate";
import { DEFAULT_FOOTER_TEXT } from "@/lib/footer";

type JsonRecord = Record<string, unknown>;

export type RawDocTreeItem = {
  path: string;
  slug: string;
  name: string;
};

type RawTreeItem = RawDocTreeItem;

export type DocsTreeLoadResult = {
  tree: DocTreeNode[];
  titlesPending: boolean;
};

export type PublicSiteSettings = {
  siteTitle: string;
  siteDescription: string;
  footerText: string;
  startPage: string;
  siteTitleGradientFrom: string;
  siteTitleGradientTo: string;
  docsIconPng16Url: string;
  docsIconPng32Url: string;
  docsIconPng180Url: string;
  customDomain: string;
  aiChatEnabled: boolean;
  aiChatAssistantName: string;
  aiChatAvatarUrl: string;
  aiChatHeaderSubtitle: string;
  aiChatWelcomeMessage: string;
  autoTranslateEnabled: boolean;
  autoTranslateLanguages: AutoTranslateLanguage[];
  themeLightAccent: string;
  themeLightSurfaceAccent: string;
  themeDarkAccent: string;
  themeDarkSurfaceAccent: string;
  themeCustomCss: string;
};

const DEFAULT_DOCS_REFRESH_INTERVAL_MINUTES = 60;
const MIN_DOCS_REFRESH_INTERVAL_MINUTES = 1;
const MAX_DOCS_REFRESH_INTERVAL_MINUTES = 1_440;
const DOMAIN_SSL_CERTIFICATE_STATES: DomainSslCertificateState[] = [
  "missing",
  "valid",
  "expiring_soon",
  "expired",
  "domain_mismatch",
  "invalid",
];

const DEFAULT_SETTINGS: AdminSettings = {
  siteTitle: "Vicky Docs",
  siteDescription: "Documentation knowledge base",
  footerText: DEFAULT_FOOTER_TEXT,
  startPage: "/home",
  siteTitleGradientFrom: "",
  siteTitleGradientTo: "",
  docsIconPng16Url: "",
  docsIconPng32Url: "",
  docsIconPng180Url: "",
  docsRefreshIntervalMinutes: DEFAULT_DOCS_REFRESH_INTERVAL_MINUTES,
  customDomain: "",
  letsEncryptEmail: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  githubDocsPath: "docs",
  githubToken: "",
  tokenConfigured: false,
  aiChatEnabled: false,
  aiChatAssistantName: DEFAULT_AI_CHAT_ASSISTANT_NAME,
  aiChatAvatarUrl: "",
  aiChatHeaderSubtitle: DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  aiChatWelcomeMessage: DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  aiChatSystemPrompt: DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  openRouterModel: DEFAULT_OPENROUTER_MODEL,
  openRouterApiKey: "",
  openRouterApiKeyConfigured: false,
  autoTranslateEnabled: false,
  autoTranslateOpenRouterModel: DEFAULT_AUTO_TRANSLATE_OPENROUTER_MODEL,
  autoTranslateLanguages: DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language })),
  themeLightAccent: "#006ecf",
  themeLightSurfaceAccent: "#7db8f0",
  themeDarkAccent: "#15A6E5",
  themeDarkSurfaceAccent: "#657276",
  themeCustomCss: "",
};

export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function msToMinutes(value: number): number {
  return clampInteger(value / 60_000, MIN_DOCS_REFRESH_INTERVAL_MINUTES, MAX_DOCS_REFRESH_INTERVAL_MINUTES);
}

function minutesToMs(value: number): number {
  return clampInteger(value, MIN_DOCS_REFRESH_INTERVAL_MINUTES, MAX_DOCS_REFRESH_INTERVAL_MINUTES) * 60_000;
}

function toAbsoluteDocPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.(md|mdx)$/i, "");

  if (!normalized) {
    return "/";
  }

  return `/${normalized}`;
}

function toDocSlug(value: string): string {
  return toAbsoluteDocPath(value).replace(/^\//, "");
}

function slugToPath(slug: string): string {
  return toAbsoluteDocPath(slug);
}

function prettyFromSlug(slug: string): string {
  const segment = slug.split("/").filter(Boolean).at(-1) ?? slug;
  return segment
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function extractMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload;
  }

  const record = asRecord(payload);
  const message = record.message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }

  const error = record.error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallback;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const rawText = await response.text();
  const payload = rawText ? safeJsonParse(rawText) : null;

  if (!response.ok) {
    throw new ApiError(
      extractMessage(payload, `Request failed with status ${response.status}`),
      response.status,
      payload,
    );
  }

  return payload as T;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function normalizeHeadings(value: unknown): MarkdownHeading[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = asRecord(entry);
      const depth = Number(record.depth);
      const text = asString(record.text).trim();
      const slug = asString(record.slug).trim();

      if (!text || !slug || !Number.isFinite(depth)) {
        return null;
      }

      return {
        depth: Math.max(1, Math.min(6, Math.floor(depth))),
        text,
        slug,
      };
    })
    .filter((entry): entry is MarkdownHeading => Boolean(entry));
}

function normalizeAutoTranslateLanguageList(source: unknown): AutoTranslateLanguage[] {
  const values = Array.isArray(source) ? source : DEFAULT_AUTO_TRANSLATE_LANGUAGES;
  const languages = values
    .map((entry) => normalizeAutoTranslateLanguage(entry))
    .filter((entry): entry is AutoTranslateLanguage => Boolean(entry));

  return languages.length > 0 ? languages : DEFAULT_AUTO_TRANSLATE_LANGUAGES.map((language) => ({ ...language }));
}

function normalizePage(source: unknown, fallbackPath = "/"): DocPage {
  const payload = asRecord(asRecord(source).page ?? source);
  const slug = asString(payload.slug) || toDocSlug(asString(payload.path));
  const path = slug ? slugToPath(slug) : toAbsoluteDocPath(asString(payload.path, fallbackPath));
  const title = asString(payload.title).trim() || prettyFromSlug(slug || "index");

  return {
    title,
    description: asString(payload.description).trim(),
    path,
    slug: slug || toDocSlug(path),
    content: asString(payload.content),
    markdown: asString(payload.markdown) || asString(payload.content),
    headings: normalizeHeadings(payload.headings),
    sourceHeadings: normalizeHeadings(payload.sourceHeadings),
    includeInPlaintextExport: asBoolean(payload.includeInPlaintextExport, true),
    updatedAt: asString(payload.updatedAt || payload.lastUpdatedAt).trim() || undefined,
    updatedBy: asString(payload.updatedBy || payload.lastUpdatedBy).trim() || undefined,
  };
}

function normalizePageMetadata(
  source: unknown,
  fallbackPath = "/",
): Pick<DocPage, "path" | "slug" | "updatedAt" | "updatedBy"> {
  const payload = asRecord(asRecord(source).metadata ?? source);
  const slug = asString(payload.slug) || toDocSlug(asString(payload.path));
  const path = slug ? slugToPath(slug) : toAbsoluteDocPath(asString(payload.path, fallbackPath));

  return {
    path,
    slug: slug || toDocSlug(path),
    updatedAt: asString(payload.updatedAt || payload.lastUpdatedAt).trim() || undefined,
    updatedBy: asString(payload.updatedBy || payload.lastUpdatedBy).trim() || undefined,
  };
}

function normalizeTreeItems(source: unknown): RawTreeItem[] {
  const payload = asRecord(source).items;

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry) => {
      const record = asRecord(entry);
      const slug = asString(record.slug).replace(/\.(md|mdx)$/i, "").trim();

      if (!slug) {
        return null;
      }

      const rawPath = asString(record.path).trim();
      const path = rawPath || `${slug}.md`;
      const name = asString(record.name).trim() || prettyFromSlug(slug);

      return {
        path,
        slug,
        name,
      };
    })
    .filter((entry): entry is RawTreeItem => Boolean(entry));
}

function createFolderNode(slug: string, name: string): DocTreeNode {
  const path = slugToPath(slug);
  return {
    id: `folder:${slug || "root"}`,
    name,
    path,
    slug,
    isFolder: true,
    children: [],
  };
}

function createDocNode(item: RawTreeItem): DocTreeNode {
  return {
    id: `doc:${item.slug}`,
    name: item.name,
    path: slugToPath(item.slug),
    slug: item.slug,
    isFolder: false,
    children: [],
  };
}

function sortTree(nodes: DocTreeNode[]): DocTreeNode[] {
  const sorted = [...nodes].sort((left, right) => {
    if (left.isFolder !== right.isFolder) {
      return left.isFolder ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });

  for (const node of sorted) {
    if (node.children.length > 0) {
      node.children = sortTree(node.children);
    }
  }

  return sorted;
}

function buildTree(items: RawTreeItem[]): DocTreeNode[] {
  const root: DocTreeNode[] = [];
  const folderIndex = new Map<string, DocTreeNode>();

  const ensureFolder = (slug: string): DocTreeNode => {
    if (folderIndex.has(slug)) {
      return folderIndex.get(slug) as DocTreeNode;
    }

    const segments = slug.split("/").filter(Boolean);
    const name = segments.at(-1) ?? "Docs";
    const folder = createFolderNode(slug, prettyFromSlug(name));
    folderIndex.set(slug, folder);

    const parentSlug = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
    if (!parentSlug) {
      root.push(folder);
    } else {
      const parent = ensureFolder(parentSlug);
      parent.children.push(folder);
    }

    return folder;
  };

  for (const item of items) {
    const parts = item.slug.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    const parentSlug = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    const node = createDocNode(item);

    if (!parentSlug) {
      root.push(node);
      continue;
    }

    const parent = ensureFolder(parentSlug);
    parent.children.push(node);
  }

  return sortTree(root);
}

export function buildDocTree(items: RawDocTreeItem[]): DocTreeNode[] {
  return buildTree(items);
}

function normalizeSearchResults(source: unknown): DocSearchResult[] {
  const payload = asRecord(source).results;

  if (!Array.isArray(payload)) {
    return [];
  }

  const results: DocSearchResult[] = [];

  for (const entry of payload) {
    const record = asRecord(entry);
    const slug = asString(record.slug).replace(/\.(md|mdx)$/i, "").trim();
    if (!slug) {
      continue;
    }

    const score = typeof record.score === "number" ? record.score : undefined;
    const excerpt = asString(record.excerpt || record.description).trim() || undefined;
    const anchor = asString(record.anchor).trim() || undefined;
    const result: DocSearchResult = {
      title: asString(record.title).trim() || asString(record.name).trim() || prettyFromSlug(slug),
      slug,
      path: slugToPath(slug),
      ...(score !== undefined ? { score } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(anchor ? { anchor } : {}),
    };

    results.push(result);
  }

  return results;
}

function normalizeSettings(source: unknown): AdminSettings {
  const payload = asRecord(asRecord(source).settings ?? source);
  const github = asRecord(payload.github);
  const docsIcon = asRecord(payload.docsIcon);
  const siteTitleGradient = asRecord(payload.siteTitleGradient);
  const domain = asRecord(payload.domain);
  const aiChat = asRecord(payload.aiChat);
  const openRouter = asRecord(payload.openRouter);
  const autoTranslate = asRecord(payload.autoTranslate);
  const theme = asRecord(payload.theme);
  const docsCacheTtlMs = asNumber(payload.docsCacheTtlMs, DEFAULT_DOCS_REFRESH_INTERVAL_MINUTES * 60_000);

  return {
    siteTitle: asString(payload.siteTitle, DEFAULT_SETTINGS.siteTitle),
    siteDescription: asString(payload.siteDescription, DEFAULT_SETTINGS.siteDescription),
    footerText: asString(payload.footerText, DEFAULT_SETTINGS.footerText),
    startPage: asString(payload.startPage, DEFAULT_SETTINGS.startPage),
    siteTitleGradientFrom: asString(siteTitleGradient.from, DEFAULT_SETTINGS.siteTitleGradientFrom),
    siteTitleGradientTo: asString(siteTitleGradient.to, DEFAULT_SETTINGS.siteTitleGradientTo),
    docsIconPng16Url: asString(docsIcon.png16Url, DEFAULT_SETTINGS.docsIconPng16Url),
    docsIconPng32Url: asString(docsIcon.png32Url, DEFAULT_SETTINGS.docsIconPng32Url),
    docsIconPng180Url: asString(docsIcon.png180Url, DEFAULT_SETTINGS.docsIconPng180Url),
    docsRefreshIntervalMinutes: msToMinutes(docsCacheTtlMs),
    customDomain: asString(domain.customDomain, DEFAULT_SETTINGS.customDomain),
    letsEncryptEmail: asString(domain.letsEncryptEmail, DEFAULT_SETTINGS.letsEncryptEmail),
    githubOwner: asString(github.owner, DEFAULT_SETTINGS.githubOwner),
    githubRepo: asString(github.repo, DEFAULT_SETTINGS.githubRepo),
    githubBranch: asString(github.branch, DEFAULT_SETTINGS.githubBranch),
    githubDocsPath: asString(github.docsPath, DEFAULT_SETTINGS.githubDocsPath),
    githubToken: "",
    tokenConfigured: asBoolean(github.tokenConfigured, false),
    aiChatEnabled: asBoolean(aiChat.enabled, DEFAULT_SETTINGS.aiChatEnabled),
    aiChatAssistantName: asString(aiChat.assistantName, DEFAULT_SETTINGS.aiChatAssistantName),
    aiChatAvatarUrl: asString(aiChat.avatarUrl, DEFAULT_SETTINGS.aiChatAvatarUrl),
    aiChatHeaderSubtitle: asString(aiChat.headerSubtitle, DEFAULT_SETTINGS.aiChatHeaderSubtitle),
    aiChatWelcomeMessage: asString(aiChat.welcomeMessage, DEFAULT_SETTINGS.aiChatWelcomeMessage),
    aiChatSystemPrompt: asString(aiChat.systemPrompt, DEFAULT_SETTINGS.aiChatSystemPrompt),
    openRouterModel: asString(aiChat.openRouterModel, DEFAULT_SETTINGS.openRouterModel),
    openRouterApiKey: "",
    openRouterApiKeyConfigured: asBoolean(
      openRouter.apiKeyConfigured,
      asBoolean(aiChat.openRouterApiKeyConfigured, false),
    ),
    autoTranslateEnabled: asBoolean(autoTranslate.enabled, DEFAULT_SETTINGS.autoTranslateEnabled),
    autoTranslateOpenRouterModel: asString(
      autoTranslate.openRouterModel,
      DEFAULT_SETTINGS.autoTranslateOpenRouterModel,
    ),
    autoTranslateLanguages: normalizeAutoTranslateLanguageList(autoTranslate.languages),
    themeLightAccent: asString(theme.lightAccent, DEFAULT_SETTINGS.themeLightAccent),
    themeLightSurfaceAccent: asString(theme.lightSurfaceAccent, DEFAULT_SETTINGS.themeLightSurfaceAccent),
    themeDarkAccent: asString(theme.darkAccent, DEFAULT_SETTINGS.themeDarkAccent),
    themeDarkSurfaceAccent: asString(theme.darkSurfaceAccent, DEFAULT_SETTINGS.themeDarkSurfaceAccent),
    themeCustomCss: asString(theme.customCss, DEFAULT_SETTINGS.themeCustomCss),
  };
}

function normalizeAuthUser(source: unknown): AuthUser | null {
  const payload = asRecord(source);
  const role = asString(payload.role).trim();
  const username = asString(payload.username).trim() || (role === "admin" ? "admin" : "");

  if ((role !== "admin" && role !== "moderator") || !username) {
    return null;
  }

  return {
    role,
    username,
  };
}

function normalizeModeratorAccount(source: unknown): ModeratorAccount | null {
  const payload = asRecord(source);
  const id = asString(payload.id).trim();
  const username = asString(payload.username).trim();
  const createdAt = asString(payload.createdAt).trim();
  const updatedAt = asString(payload.updatedAt).trim();

  if (!id || !username) {
    return null;
  }

  return {
    id,
    username,
    createdAt,
    updatedAt,
  };
}

function normalizeModeratorAccounts(source: unknown): ModeratorAccount[] {
  const rawModerators = asRecord(source).moderators;
  return (Array.isArray(rawModerators) ? rawModerators : [])
    .map((entry) => normalizeModeratorAccount(entry))
    .filter((entry): entry is ModeratorAccount => Boolean(entry));
}

function normalizeVisitorStatsPeriods(source: unknown): VisitorStatsPeriod[] {
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((entry) => {
      const record = asRecord(entry);
      const key = asString(record.key).trim();
      if (!key) {
        return null;
      }

      return {
        key,
        label: asString(record.label, key).trim() || key,
        visits: Math.max(0, Math.round(asNumber(record.visits, asNumber(record.visitors, 0)))),
        visitors: Math.max(0, Math.round(asNumber(record.visitors, 0))),
        current: asBoolean(record.current, false),
      };
    })
    .filter((entry): entry is VisitorStatsPeriod => Boolean(entry));
}

function normalizeVisitorStatsPages(source: unknown): VisitorStatsPage[] {
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((entry) => {
      const record = asRecord(entry);
      const slug = asString(record.slug).trim();
      if (!slug) {
        return null;
      }

      return {
        path: asString(record.path, `/${slug}`).trim() || `/${slug}`,
        slug,
        title: asString(record.title, slug).trim() || slug,
        visits: Math.max(0, Math.round(asNumber(record.visits, asNumber(record.visitors, 0)))),
        visitors: Math.max(0, Math.round(asNumber(record.visitors, 0))),
      };
    })
    .filter((entry): entry is VisitorStatsPage => Boolean(entry));
}

function normalizeVisitorStatsScopeData(source: unknown, fallbackLabel: string): VisitorStatsScopeData {
  const payload = asRecord(source);
  const currentPeriodKey = asString(payload.currentPeriodKey).trim();
  const currentPeriodLabel = asString(payload.currentPeriodLabel, fallbackLabel).trim() || fallbackLabel;

  return {
    totalVisits: Math.max(0, Math.round(asNumber(payload.totalVisits, asNumber(payload.totalVisitors, 0)))),
    totalVisitors: Math.max(0, Math.round(asNumber(payload.totalVisitors, 0))),
    currentPeriodKey,
    currentPeriodLabel,
    periods: normalizeVisitorStatsPeriods(payload.periods),
    pages: normalizeVisitorStatsPages(payload.pages),
  };
}

function normalizeVisitorStatsSummary(source: unknown): VisitorStatsSummary {
  const payload = asRecord(asRecord(source).stats ?? source);
  const scopes = asRecord(payload.scopes);

  return {
    updatedAt: asString(payload.updatedAt).trim() || new Date(0).toISOString(),
    scopes: {
      allTime: normalizeVisitorStatsScopeData(scopes.allTime, "All time"),
      daily: normalizeVisitorStatsScopeData(scopes.daily, "Today"),
      weekly: normalizeVisitorStatsScopeData(scopes.weekly, "This week"),
      monthly: normalizeVisitorStatsScopeData(scopes.monthly, "This month"),
      yearly: normalizeVisitorStatsScopeData(scopes.yearly, "This year"),
    },
  };
}

function normalizeDocsRefreshResult(source: unknown): DocsRefreshResult {
  const payload = asRecord(asRecord(source).refresh ?? source);

  return {
    pageCount: Math.max(0, Math.round(asNumber(payload.pageCount, 0))),
    fetchedAt: asString(payload.fetchedAt).trim() || new Date().toISOString(),
    expiresAt: asString(payload.expiresAt).trim() || new Date().toISOString(),
  };
}

function normalizeAdminTranslationRequestResult(source: unknown): AdminTranslationRequestResult {
  const payload = asRecord(asRecord(source).result ?? source);
  const rawFailures = payload.failures;
  const failures = Array.isArray(rawFailures)
    ? rawFailures
        .map((entry) => {
          const failure = asRecord(entry);
          const slug = asString(failure.slug).trim();
          const path = asString(failure.path).trim();
          const error = asString(failure.error).trim();

          if (!slug && !path && !error) {
            return null;
          }

          return {
            slug,
            path,
            error: error || "Translation request failed.",
          };
        })
        .filter((entry): entry is AdminTranslationRequestResult["failures"][number] => Boolean(entry))
    : [];

  return {
    totalPages: Math.max(0, Math.round(asNumber(payload.totalPages, 0))),
    cachedPages: Math.max(0, Math.round(asNumber(payload.cachedPages, 0))),
    requestedPages: Math.max(0, Math.round(asNumber(payload.requestedPages, 0))),
    translatedPages: Math.max(0, Math.round(asNumber(payload.translatedPages, 0))),
    failedPages: Math.max(0, Math.round(asNumber(payload.failedPages, failures.length))),
    failures,
  };
}

function normalizeAdminLanguageTranslationCacheStatuses(source: unknown): AdminLanguageTranslationCacheStatus[] {
  const rawStatuses = asRecord(source).statuses;
  if (!Array.isArray(rawStatuses)) {
    return [];
  }

  return rawStatuses
    .map((entry) => {
      const payload = asRecord(entry);
      const languageCode = asString(payload.languageCode).trim();

      if (!languageCode) {
        return null;
      }

      return {
        languageCode,
        cachedPages: Math.max(0, Math.round(asNumber(payload.cachedPages, 0))),
        totalPages: Math.max(0, Math.round(asNumber(payload.totalPages, 0))),
        sourceLanguage: asBoolean(payload.sourceLanguage, false),
      };
    })
    .filter((entry): entry is AdminLanguageTranslationCacheStatus => Boolean(entry));
}

function normalizePublicSiteSettings(source: unknown): PublicSiteSettings {
  const payload = asRecord(asRecord(source).settings ?? source);
  const docsIcon = asRecord(payload.docsIcon);
  const siteTitleGradient = asRecord(payload.siteTitleGradient);
  const domain = asRecord(payload.domain);
  const aiChat = asRecord(payload.aiChat);
  const autoTranslate = asRecord(payload.autoTranslate);
  const theme = asRecord(payload.theme);

  return {
    siteTitle: asString(payload.siteTitle, DEFAULT_SETTINGS.siteTitle),
    siteDescription: asString(payload.siteDescription, DEFAULT_SETTINGS.siteDescription),
    footerText: asString(payload.footerText, DEFAULT_SETTINGS.footerText),
    startPage: asString(payload.startPage, DEFAULT_SETTINGS.startPage),
    siteTitleGradientFrom: asString(siteTitleGradient.from, DEFAULT_SETTINGS.siteTitleGradientFrom),
    siteTitleGradientTo: asString(siteTitleGradient.to, DEFAULT_SETTINGS.siteTitleGradientTo),
    docsIconPng16Url: asString(docsIcon.png16Url, DEFAULT_SETTINGS.docsIconPng16Url),
    docsIconPng32Url: asString(docsIcon.png32Url, DEFAULT_SETTINGS.docsIconPng32Url),
    docsIconPng180Url: asString(docsIcon.png180Url, DEFAULT_SETTINGS.docsIconPng180Url),
    customDomain: asString(domain.customDomain, DEFAULT_SETTINGS.customDomain),
    aiChatEnabled: asBoolean(aiChat.enabled, DEFAULT_SETTINGS.aiChatEnabled),
    aiChatAssistantName: asString(aiChat.assistantName, DEFAULT_SETTINGS.aiChatAssistantName),
    aiChatAvatarUrl: asString(aiChat.avatarUrl, DEFAULT_SETTINGS.aiChatAvatarUrl),
    aiChatHeaderSubtitle: asString(aiChat.headerSubtitle, DEFAULT_SETTINGS.aiChatHeaderSubtitle),
    aiChatWelcomeMessage: asString(aiChat.welcomeMessage, DEFAULT_SETTINGS.aiChatWelcomeMessage),
    autoTranslateEnabled: asBoolean(autoTranslate.enabled, DEFAULT_SETTINGS.autoTranslateEnabled),
    autoTranslateLanguages: normalizeAutoTranslateLanguageList(autoTranslate.languages),
    themeLightAccent: asString(theme.lightAccent, DEFAULT_SETTINGS.themeLightAccent),
    themeLightSurfaceAccent: asString(theme.lightSurfaceAccent, DEFAULT_SETTINGS.themeLightSurfaceAccent),
    themeDarkAccent: asString(theme.darkAccent, DEFAULT_SETTINGS.themeDarkAccent),
    themeDarkSurfaceAccent: asString(theme.darkSurfaceAccent, DEFAULT_SETTINGS.themeDarkSurfaceAccent),
    themeCustomCss: asString(theme.customCss, DEFAULT_SETTINGS.themeCustomCss),
  };
}

function isDomainSslCertificateState(value: string): value is DomainSslCertificateState {
  return DOMAIN_SSL_CERTIFICATE_STATES.includes(value as DomainSslCertificateState);
}

function normalizeDomainSslRuntimeStatus(source: unknown): DomainSslRuntimeStatus {
  const payload = asRecord(asRecord(source).status ?? source);
  const sourceValue = asString(payload.source).trim();
  const certificateStateValue = asString(payload.certificateState).trim();
  const checkedAt = asString(payload.checkedAt).trim();
  const expiresAt = asString(payload.certificateExpiresAt).trim();

  return {
    source: sourceValue === "runtime" ? "runtime" : "best-effort",
    configured: asBoolean(payload.configured, false),
    customDomain: asString(payload.customDomain),
    letsEncryptEmail: asString(payload.letsEncryptEmail),
    certificateState: isDomainSslCertificateState(certificateStateValue) ? certificateStateValue : "missing",
    certificatePresent: asBoolean(payload.certificatePresent, false),
    certificateValidForDomain: asNullableBoolean(payload.certificateValidForDomain),
    certificateExpiresAt: expiresAt || null,
    checkedAt: checkedAt || new Date().toISOString(),
    message: asString(payload.message, "SSL runtime status is unavailable."),
  };
}

export function formatApiError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

export async function fetchDocsTree(languageCode?: string): Promise<DocTreeNode[]> {
  const result = await fetchDocsTreeState(languageCode);
  return result.tree;
}

export async function fetchDocsTreeState(
  languageCode?: string,
  options?: { waitForTitles?: boolean },
): Promise<DocsTreeLoadResult> {
  const params = new URLSearchParams();
  if (languageCode) {
    params.set("language", languageCode);
  }
  if (options?.waitForTitles) {
    params.set("waitForTitles", "1");
  }

  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await requestJson<unknown>(`/api/docs/tree${query}`);
  return {
    tree: buildTree(normalizeTreeItems(response)),
    titlesPending: asBoolean(asRecord(response).titlesPending, false),
  };
}

export async function fetchDocPage(pathOrSlug: string, languageCode?: string): Promise<DocPage> {
  const slug = toDocSlug(pathOrSlug);
  const query = new URLSearchParams({
    slug,
    ...(languageCode ? { language: languageCode } : {}),
  });
  const response = await requestJson<unknown>(`/api/docs/page?${query.toString()}`);
  return normalizePage(response, slugToPath(slug));
}

export async function fetchDocPageMetadata(
  pathOrSlug: string,
): Promise<Pick<DocPage, "path" | "slug" | "updatedAt" | "updatedBy">> {
  const slug = toDocSlug(pathOrSlug);
  const query = new URLSearchParams({ slug });
  const response = await requestJson<unknown>(`/api/docs/page-metadata?${query.toString()}`);
  return normalizePageMetadata(response, slugToPath(slug));
}

export async function recordDisplayedDocPageVisit(page: Pick<DocPage, "path" | "slug" | "title">): Promise<void> {
  await requestJson<unknown>("/api/docs/visit", {
    method: "POST",
    keepalive: true,
    body: JSON.stringify({
      path: page.path,
      slug: page.slug,
      title: page.title,
    }),
  });
}

export async function fetchAdminDocPage(pathOrSlug: string): Promise<DocPage> {
  const slug = toDocSlug(pathOrSlug);
  const query = new URLSearchParams({ slug });
  const response = await requestJson<unknown>(`/api/admin/docs?${query.toString()}`);
  return normalizePage(asRecord(response).page, slugToPath(slug));
}

export async function searchDocs(query: string, signal?: AbortSignal, languageCode?: string): Promise<DocSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const params = new URLSearchParams({ q: trimmed });
  if (languageCode?.trim()) {
    params.set("language", languageCode.trim());
  }

  const response = await requestJson<unknown>(`/api/docs/search?${params.toString()}`, { signal });
  return normalizeSearchResults(response);
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const response = await requestJson<unknown>("/api/auth/me");
    const payload = asRecord(response);
    if (!asBoolean(payload.authenticated, false)) {
      return null;
    }

    return normalizeAuthUser(payload);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return null;
    }
    throw error;
  }
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const response = await requestJson<unknown>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

  const user = normalizeAuthUser(response);
  if (!user) {
    throw new ApiError("Login succeeded but the server did not return a valid user.", 500, response);
  }

  return user;
}

export async function logout(): Promise<void> {
  await requestJson("/api/auth/logout", { method: "POST" });
}

export async function fetchAdminSettings(): Promise<AdminSettings> {
  const response = await requestJson<unknown>("/api/admin/settings");
  return normalizeSettings(response);
}

export async function fetchAdminModerators(): Promise<ModeratorAccount[]> {
  const response = await requestJson<unknown>("/api/admin/moderators");
  return normalizeModeratorAccounts(response);
}

export async function createAdminModerator(input: { username: string; password: string }): Promise<ModeratorAccount> {
  const response = await requestJson<unknown>("/api/admin/moderators", {
    method: "POST",
    body: JSON.stringify(input),
  });
  const moderator = normalizeModeratorAccount(asRecord(response).moderator);
  if (!moderator) {
    throw new ApiError("The server did not return the created moderator account.", 500, response);
  }

  return moderator;
}

export async function updateAdminModerator(
  id: string,
  input: { username?: string; password?: string },
): Promise<ModeratorAccount> {
  const response = await requestJson<unknown>(`/api/admin/moderators/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
  const moderator = normalizeModeratorAccount(asRecord(response).moderator);
  if (!moderator) {
    throw new ApiError("The server did not return the updated moderator account.", 500, response);
  }

  return moderator;
}

export async function deleteAdminModerator(id: string): Promise<void> {
  await requestJson(`/api/admin/moderators/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function fetchAdminDomainSslStatus(): Promise<DomainSslRuntimeStatus> {
  const response = await requestJson<unknown>("/api/admin/domain-status");
  return normalizeDomainSslRuntimeStatus(response);
}

export async function fetchAdminVisitorStats(): Promise<VisitorStatsSummary> {
  const response = await requestJson<unknown>("/api/admin/visitors");
  return normalizeVisitorStatsSummary(response);
}

export async function saveAdminSettings(settings: AdminSettings): Promise<AdminSettings> {
  const payload: Record<string, unknown> = {
    siteTitle: settings.siteTitle,
    siteDescription: settings.siteDescription,
    footerText: settings.footerText,
    startPage: settings.startPage,
    siteTitleGradient: {
      from: settings.siteTitleGradientFrom,
      to: settings.siteTitleGradientTo,
    },
    docsIcon: {
      png16Url: settings.docsIconPng16Url,
      png32Url: settings.docsIconPng32Url,
      png180Url: settings.docsIconPng180Url,
    },
    docsCacheTtlMs: minutesToMs(settings.docsRefreshIntervalMinutes),
    domain: {
      customDomain: settings.customDomain.trim(),
      letsEncryptEmail: settings.letsEncryptEmail.trim(),
    },
    theme: {
      lightAccent: settings.themeLightAccent,
      lightSurfaceAccent: settings.themeLightSurfaceAccent,
      darkAccent: settings.themeDarkAccent,
      darkSurfaceAccent: settings.themeDarkSurfaceAccent,
      customCss: settings.themeCustomCss,
    },
    github: {
      owner: settings.githubOwner,
      repo: settings.githubRepo,
      branch: settings.githubBranch,
      docsPath: settings.githubDocsPath,
    },
    aiChat: {
      enabled: settings.aiChatEnabled,
      assistantName: settings.aiChatAssistantName,
      avatarUrl: settings.aiChatAvatarUrl,
      headerSubtitle: settings.aiChatHeaderSubtitle,
      welcomeMessage: settings.aiChatWelcomeMessage,
      systemPrompt: settings.aiChatSystemPrompt,
      openRouterModel: settings.openRouterModel,
    },
    openRouter: {},
    autoTranslate: {
      enabled: settings.autoTranslateEnabled,
      openRouterModel: settings.autoTranslateOpenRouterModel,
      languages: settings.autoTranslateLanguages,
    },
  };

  const github = payload.github as Record<string, unknown>;
  if (settings.githubToken.trim()) {
    github.token = settings.githubToken.trim();
  }

  if (settings.openRouterApiKey.trim()) {
    const openRouter = payload.openRouter as Record<string, unknown>;
    openRouter.apiKey = settings.openRouterApiKey.trim();
  }

  const response = await requestJson<unknown>("/api/admin/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });

  return normalizeSettings(response);
}

export async function clearAdminGitHubToken(): Promise<AdminSettings> {
  const response = await requestJson<unknown>("/api/admin/settings", {
    method: "PATCH",
    body: JSON.stringify({ github: { token: "" } }),
  });

  return normalizeSettings(response);
}

export async function clearAdminOpenRouterApiKey(): Promise<AdminSettings> {
  const response = await requestJson<unknown>("/api/admin/settings", {
    method: "PATCH",
    body: JSON.stringify({
      aiChat: { enabled: false },
      autoTranslate: { enabled: false },
      openRouter: { apiKey: "" },
    }),
  });

  return normalizeSettings(response);
}

export async function refreshAdminDocsCache(): Promise<DocsRefreshResult> {
  const response = await requestJson<unknown>("/api/admin/docs/refresh", {
    method: "POST",
  });

  return normalizeDocsRefreshResult(response);
}

export async function requestAdminLanguageTranslations(
  language: AutoTranslateLanguage,
): Promise<AdminTranslationRequestResult> {
  const response = await requestJson<unknown>("/api/admin/translations/request", {
    method: "POST",
    body: JSON.stringify({ language }),
  });

  return normalizeAdminTranslationRequestResult(response);
}

export async function fetchAdminLanguageTranslationCacheStatuses(
  languages: AutoTranslateLanguage[],
  model: string,
): Promise<AdminLanguageTranslationCacheStatus[]> {
  const response = await requestJson<unknown>("/api/admin/translations/status", {
    method: "POST",
    body: JSON.stringify({ languages, model }),
  });

  return normalizeAdminLanguageTranslationCacheStatuses(response);
}

export async function fetchPublicSiteSettings(): Promise<PublicSiteSettings> {
  const response = await requestJson<unknown>("/api/public/settings");
  return normalizePublicSiteSettings(response);
}

export async function sendDocsAiChatMessage(messages: {
  role: "user" | "assistant";
  text?: string;
  images?: Array<{ name?: string; dataUrl: string }>;
}[]): Promise<AiChatReply> {
  const response = await requestJson<unknown>("/api/ai/chat", {
    method: "POST",
    body: JSON.stringify({
      messages,
    }),
  });

  const payload = asRecord(asRecord(response).reply);

  return {
    role: "assistant",
    text: asString(payload.text).trim(),
    name: asString(payload.name).trim() || undefined,
  };
}

export async function testAdminConnection(settings: AdminSettings): Promise<string> {
  const response = await requestJson<unknown>("/api/admin/test-connection", {
    method: "POST",
    body: JSON.stringify({
      owner: settings.githubOwner,
      repo: settings.githubRepo,
      branch: settings.githubBranch,
      docsPath: settings.githubDocsPath,
      token: settings.githubToken.trim() || undefined,
    }),
  });

  const payload = asRecord(response);
  const ok = asBoolean(payload.ok, false);

  if (!ok) {
    const error = extractMessage(payload, "Connection test failed.");
    throw new ApiError(error, 400, payload);
  }

  const defaultBranch = asString(payload.defaultBranch).trim();
  return defaultBranch ? `Connection OK. Repo default branch: ${defaultBranch}.` : "Connection OK.";
}

export async function fetchAdminDocs(): Promise<DocTreeNode[]> {
  return fetchDocsTree(DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE);
}

export async function saveAdminDoc(doc: EditableDoc): Promise<DocPage> {
  const payload = {
    slug: doc.slug || toDocSlug(doc.path),
    path: doc.path,
    title: doc.title,
    description: doc.description,
    content: doc.content,
    includeInPlaintextExport: doc.includeInPlaintextExport,
    commitMessage: doc.commitMessage,
  };

  const response = await requestJson<unknown>("/api/admin/docs", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return normalizePage(asRecord(response).page, doc.path);
}

export function flattenTree(nodes: DocTreeNode[]): DocTreeNode[] {
  const result: DocTreeNode[] = [];

  const visit = (items: DocTreeNode[]) => {
    for (const item of items) {
      result.push(item);
      if (item.children.length > 0) {
        visit(item.children);
      }
    }
  };

  visit(nodes);
  return result;
}

export function firstLeafPath(nodes: DocTreeNode[]): string | null {
  for (const node of nodes) {
    if (!node.isFolder) {
      return node.path;
    }

    const nested = firstLeafPath(node.children);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export { toAbsoluteDocPath };
