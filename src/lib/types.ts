export type ThemeMode = "light" | "dark";

export interface GitHubSettings {
  owner: string;
  repo: string;
  branch: string;
  docsPath: string;
  tokenEncrypted: string | null;
  cacheEpoch: string;
}

export interface DocsIconSettings {
  png16Url: string;
  png32Url: string;
  png180Url: string;
}

export interface SiteTitleGradientSettings {
  from: string;
  to: string;
}

export interface DomainSettings {
  customDomain: string;
  letsEncryptEmail: string;
}

export interface AiChatSettings {
  enabled: boolean;
  assistantName: string;
  avatarUrl: string;
  headerSubtitle: string;
  welcomeMessage: string;
  openRouterModel: string;
  systemPrompt: string;
}

export interface OpenRouterSettings {
  apiKeyEncrypted: string | null;
}

export interface AutoTranslateLanguage {
  name: string;
  code: string;
  icon: string;
  enabled: boolean;
}

export interface AutoTranslateSettings {
  enabled: boolean;
  openRouterModel: string;
  requestTimeoutMs: number;
  languages: AutoTranslateLanguage[];
  localizationPath: string;
}

export interface ThemeCustomizationSettings {
  lightAccent: string;
  lightSurfaceAccent: string;
  darkAccent: string;
  darkSurfaceAccent: string;
  customCss: string;
}

export interface ModeratorAccount {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export type VisitorStatsScope = "allTime" | "daily" | "weekly" | "monthly" | "yearly";

/** A visit handed to analytics storage; `visitorId` is the salted hash of the client address. */
export interface VisitorEventInput {
  eventId: string | null;
  page: VisitorPageIdentity;
  visitedAt: number;
  visitorId: string;
}

/** Progress of folding stored visits that are not part of the numbers yet. */
export interface VisitorAnalyticsProgress {
  processed: number;
  total: number;
  etaSeconds: number | null;
}

type VisitorAnalyticsPageCounts = Array<[pageId: number, count: number]>;

/** Aggregate numbers read by the analytics worker; `visitor-analytics-store.mjs` documents their meaning. */
export interface VisitorAnalyticsSummaryData {
  computedAt: number;
  lastVisitAt: number | null;
  /** False while stored visits still wait to be folded into the aggregates. */
  complete: boolean;
  pages: Array<[pageId: number, slug: string, path: string, title: string]>;
  allTime: {
    visitors: number;
    days: Array<[day: number, visits: number, visitors: number]>;
    pages: Array<[pageId: number, visits: number, visitors: number]>;
  };
  last24Hours: {
    visitors: number;
    hours: Array<[hour: number, visits: number, visitors: number]>;
    pageVisits: VisitorAnalyticsPageCounts;
    pageVisitors: VisitorAnalyticsPageCounts;
  };
  recentDays: Array<{
    dayCount: number;
    visitors: number;
    pageVisits: VisitorAnalyticsPageCounts;
    pageVisitors: VisitorAnalyticsPageCounts;
  }>;
}

export interface VisitorAnalyticsStatus {
  /** Set while stored visits are still being folded; the numbers are incomplete until then. */
  catchingUp: VisitorAnalyticsProgress | null;
  /** Whether newer numbers are being computed than the ones returned. */
  refreshing: boolean;
  error: string | null;
}

export interface VisitorStatsPeriodSummary {
  key: string;
  label: string;
  visits: number;
  visitors: number;
  current: boolean;
}

export interface VisitorStatsPageSummary {
  path: string;
  slug: string;
  title: string;
  visits: number;
  visitors: number;
}

export interface VisitorStatsScopeSummary {
  totalVisits: number;
  totalVisitors: number;
  currentPeriodKey: string;
  currentPeriodLabel: string;
  periods: VisitorStatsPeriodSummary[];
  pages: VisitorStatsPageSummary[];
}

export type VisitorStatsScopeSummaries = Record<VisitorStatsScope, VisitorStatsScopeSummary>;

export interface VisitorStatsSummary {
  /** Time of the latest recorded visit, or `computedAt` when there is none. */
  updatedAt: string;
  /** When the numbers were read from the aggregates. */
  computedAt: string;
  scopes: VisitorStatsScopeSummaries;
}

export interface VisitorStatsResponse {
  stats: VisitorStatsSummary | null;
  status: VisitorAnalyticsStatus;
}

export interface VisitorPageIdentity {
  path: string;
  slug: string;
  title: string;
}

export interface PerformanceMemoryStats {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
}

export interface PerformanceCpuStats {
  usagePercent: number;
  logicalCores: number;
  sampleMs: number;
}

export interface PerformanceDriveStats {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface PerformanceStatsSnapshot {
  updatedAt: string;
  memory: PerformanceMemoryStats;
  cpu: PerformanceCpuStats;
  drive: PerformanceDriveStats;
}

export interface AppSettings {
  siteTitle: string;
  siteDescription: string;
  footerText: string;
  startPage: string;
  siteTitleGradient: SiteTitleGradientSettings;
  docsIcon: DocsIconSettings;
  docsCacheTtlMs: number;
  domain: DomainSettings;
  github: GitHubSettings;
  openRouter: OpenRouterSettings;
  aiChat: AiChatSettings;
  autoTranslate: AutoTranslateSettings;
  theme: ThemeCustomizationSettings;
  updatedAt: string;
}

export interface DocsStore {
  version: 13;
  settings: AppSettings;
  moderators: ModeratorAccount[];
  adminSessionSecurity: {
    sessionEpoch: string;
    credentialFingerprint: string;
  };
}

export interface GitHubRuntimeConfig {
  owner: string;
  repo: string;
  branch: string;
  docsPath: string;
  token: string;
  cacheEpoch?: string;
}

export interface GitHubValidationResult {
  valid: boolean;
  errors: string[];
}

export interface MarkdownHeading {
  depth: number;
  text: string;
  slug: string;
}

export interface ParsedMarkdownDocument {
  title: string;
  description: string;
  content: string;
  headings: MarkdownHeading[];
  includeInPlaintextExport: boolean;
  /** Blob SHA of the source page version a translation was made from, when it records one. */
  sourceBlobSha?: string;
}

export interface GitHubDocTreeItem {
  path: string;
  slug: string;
  name: string;
}

export interface GitHubDocPage {
  path: string;
  slug: string;
  sha: string;
  title: string;
  description: string;
  content: string;
  markdown: string;
  headings: MarkdownHeading[];
  includeInPlaintextExport: boolean;
  updatedAt?: string;
  updatedBy?: string;
  languageCode?: string;
  sourceLanguage?: boolean;
  sourcePath?: string;
  sourceSlug?: string;
  sourceUpdatedAt?: string;
  translationPath?: string;
  translationUpdatedAt?: string;
  translationStale?: boolean;
  localizationStatus?: "source" | "current" | "outdated" | "missing";
}

export interface GitHubPlaintextDocPage {
  path: string;
  slug: string;
  title: string;
  markdown: string;
  includeInPlaintextExport: boolean;
}

export interface SaveGitHubDocInput {
  slug?: string;
  path?: string;
  title?: string;
  description?: string;
  content?: string;
  markdown?: string;
  includeInPlaintextExport?: boolean;
  commitMessage?: string;
}

export interface SaveGitHubDocResult {
  path: string;
  slug: string;
  commitSha: string;
  page: GitHubDocPage;
}
