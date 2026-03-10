import {
  type AdminSettings,
  type AiChatReply,
  type AuthUser,
  type DocPage,
  type DocSearchResult,
  type DocTreeNode,
  type DomainSslCertificateState,
  type DomainSslRuntimeStatus,
  type EditableDoc,
  type MarkdownHeading,
} from "@/components/types";
import { DEFAULT_AI_CHAT_ASSISTANT_NAME, DEFAULT_AI_CHAT_SYSTEM_PROMPT, DEFAULT_OPENROUTER_MODEL } from "@/lib/ai-chat";
import { DEFAULT_FOOTER_TEXT } from "@/lib/footer";

type JsonRecord = Record<string, unknown>;

type RawTreeItem = {
  path: string;
  slug: string;
  name: string;
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
  themeLightAccent: string;
  themeLightSurfaceAccent: string;
  themeDarkAccent: string;
  themeDarkSurfaceAccent: string;
  themeCustomCss: string;
};

const DEFAULT_DOCS_CACHE_TTL_SECONDS = 30;
const MIN_DOCS_CACHE_TTL_SECONDS = 1;
const MAX_DOCS_CACHE_TTL_SECONDS = 86_400;
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
  docsCacheTtlSeconds: DEFAULT_DOCS_CACHE_TTL_SECONDS,
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
  aiChatSystemPrompt: DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  openRouterModel: DEFAULT_OPENROUTER_MODEL,
  openRouterApiKey: "",
  openRouterApiKeyConfigured: false,
  themeLightAccent: "#006ecf",
  themeLightSurfaceAccent: "#7db8f0",
  themeDarkAccent: "#5caedf",
  themeDarkSurfaceAccent: "#47729c",
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

function msToSeconds(value: number): number {
  return clampInteger(value / 1000, MIN_DOCS_CACHE_TTL_SECONDS, MAX_DOCS_CACHE_TTL_SECONDS);
}

function secondsToMs(value: number): number {
  return clampInteger(value, MIN_DOCS_CACHE_TTL_SECONDS, MAX_DOCS_CACHE_TTL_SECONDS) * 1000;
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
    includeInPlaintextExport: asBoolean(payload.includeInPlaintextExport, true),
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
  const theme = asRecord(payload.theme);
  const docsCacheTtlMs = asNumber(payload.docsCacheTtlMs, DEFAULT_DOCS_CACHE_TTL_SECONDS * 1000);

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
    docsCacheTtlSeconds: msToSeconds(docsCacheTtlMs),
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
    aiChatSystemPrompt: asString(aiChat.systemPrompt, DEFAULT_SETTINGS.aiChatSystemPrompt),
    openRouterModel: asString(aiChat.openRouterModel, DEFAULT_SETTINGS.openRouterModel),
    openRouterApiKey: "",
    openRouterApiKeyConfigured: asBoolean(aiChat.openRouterApiKeyConfigured, false),
    themeLightAccent: asString(theme.lightAccent, DEFAULT_SETTINGS.themeLightAccent),
    themeLightSurfaceAccent: asString(theme.lightSurfaceAccent, DEFAULT_SETTINGS.themeLightSurfaceAccent),
    themeDarkAccent: asString(theme.darkAccent, DEFAULT_SETTINGS.themeDarkAccent),
    themeDarkSurfaceAccent: asString(theme.darkSurfaceAccent, DEFAULT_SETTINGS.themeDarkSurfaceAccent),
    themeCustomCss: asString(theme.customCss, DEFAULT_SETTINGS.themeCustomCss),
  };
}

function normalizePublicSiteSettings(source: unknown): PublicSiteSettings {
  const payload = asRecord(asRecord(source).settings ?? source);
  const docsIcon = asRecord(payload.docsIcon);
  const siteTitleGradient = asRecord(payload.siteTitleGradient);
  const domain = asRecord(payload.domain);
  const aiChat = asRecord(payload.aiChat);
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

export async function fetchDocsTree(): Promise<DocTreeNode[]> {
  const response = await requestJson<unknown>("/api/docs/tree");
  return buildTree(normalizeTreeItems(response));
}

export async function fetchDocPage(pathOrSlug: string): Promise<DocPage> {
  const slug = toDocSlug(pathOrSlug);
  const query = new URLSearchParams({ slug });
  const response = await requestJson<unknown>(`/api/docs/page?${query.toString()}`);
  return normalizePage(response, slugToPath(slug));
}

export async function searchDocs(query: string, signal?: AbortSignal): Promise<DocSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const params = new URLSearchParams({ q: trimmed });
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

    return {
      role: "admin",
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return null;
    }
    throw error;
  }
}

export async function login(password: string): Promise<void> {
  await requestJson("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function logout(): Promise<void> {
  await requestJson("/api/auth/logout", { method: "POST" });
}

export async function fetchAdminSettings(): Promise<AdminSettings> {
  const response = await requestJson<unknown>("/api/admin/settings");
  return normalizeSettings(response);
}

export async function fetchAdminDomainSslStatus(): Promise<DomainSslRuntimeStatus> {
  const response = await requestJson<unknown>("/api/admin/domain-status");
  return normalizeDomainSslRuntimeStatus(response);
}

export async function saveAdminSettings(
  settings: AdminSettings,
  options?: { clearToken?: boolean; clearOpenRouterApiKey?: boolean },
): Promise<AdminSettings> {
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
    docsCacheTtlMs: secondsToMs(settings.docsCacheTtlSeconds),
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
      systemPrompt: settings.aiChatSystemPrompt,
      openRouterModel: settings.openRouterModel,
    },
  };

  const github = payload.github as Record<string, unknown>;
  if (settings.githubToken.trim()) {
    github.token = settings.githubToken.trim();
  } else if (options?.clearToken) {
    github.token = "";
  }

  const aiChat = payload.aiChat as Record<string, unknown>;
  if (settings.openRouterApiKey.trim()) {
    aiChat.openRouterApiKey = settings.openRouterApiKey.trim();
  } else if (options?.clearOpenRouterApiKey) {
    aiChat.openRouterApiKey = "";
  }

  const response = await requestJson<unknown>("/api/admin/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });

  return normalizeSettings(response);
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
  return fetchDocsTree();
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
