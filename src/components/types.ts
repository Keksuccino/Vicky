export type ThemeMode = "light" | "dark";

export type ThemeCustomization = {
  lightAccent: string;
  lightSurfaceAccent: string;
  darkAccent: string;
  darkSurfaceAccent: string;
  customCss: string;
};

export type AutoTranslateLanguage = {
  name: string;
  code: string;
  icon: string;
  enabled: boolean;
};

export type MarkdownHeading = {
  depth: number;
  text: string;
  slug: string;
};

export type DocTreeNode = {
  id: string;
  name: string;
  path: string;
  slug: string;
  isFolder: boolean;
  children: DocTreeNode[];
};

export type DocPage = {
  title: string;
  description: string;
  path: string;
  slug: string;
  content: string;
  markdown: string;
  renderedHtml: string;
  headings: MarkdownHeading[];
  sourceHeadings?: MarkdownHeading[];
  includeInPlaintextExport: boolean;
  updatedAt?: string;
  updatedBy?: string;
};

export type DocPageChrome = Omit<DocPage, "content" | "markdown" | "renderedHtml">;

export type DocSearchResult = {
  title: string;
  path: string;
  slug: string;
  score?: number;
  excerpt?: string;
  anchor?: string;
};

export type AuthUser = {
  role: "admin" | "moderator";
  username: string;
};

export type ModeratorAccount = {
  id: string;
  username: string;
  createdAt: string;
  updatedAt: string;
};

export type VisitorStatsScope = "allTime" | "daily" | "weekly" | "monthly" | "yearly";

export type VisitorStatsPeriod = {
  key: string;
  label: string;
  visits: number;
  visitors: number;
  current: boolean;
};

export type VisitorStatsPage = {
  path: string;
  slug: string;
  title: string;
  visits: number;
  visitors: number;
};

export type VisitorStatsScopeData = {
  totalVisits: number;
  totalVisitors: number;
  currentPeriodKey: string;
  currentPeriodLabel: string;
  periods: VisitorStatsPeriod[];
  pages: VisitorStatsPage[];
};

export type VisitorStatsSummary = {
  updatedAt: string;
  scopes: Record<VisitorStatsScope, VisitorStatsScopeData>;
};

export type PerformanceMemoryStats = {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
};

export type PerformanceCpuStats = {
  usagePercent: number;
  logicalCores: number;
  sampleMs: number;
};

export type PerformanceDriveStats = {
  path: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  availableBytes: number;
  usagePercent: number;
};

export type PerformanceStatsSource = "server" | "windows-host";

export type PerformanceStatsSnapshot = {
  updatedAt: string;
  source: PerformanceStatsSource;
  sourceLabel: string;
  memory: PerformanceMemoryStats;
  cpu: PerformanceCpuStats;
  drive: PerformanceDriveStats;
};

export type DocsRefreshResult = {
  pageCount: number;
  fetchedAt: string;
  expiresAt: string;
};

export type AdminTranslationRequestResult = {
  totalPages: number;
  cachedPages: number;
  requestedPages: number;
  translatedPages: number;
  failedPages: number;
  failures: Array<{
    slug: string;
    path: string;
    error: string;
  }>;
};

export type AdminTranslationJobLogEntry = {
  id: number;
  createdAt: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  details?: string;
  languageCode?: string;
  path?: string;
  slug?: string;
};

export type AdminTranslationJobSnapshot = {
  id: string;
  status: "running" | "completed" | "completed_with_failures" | "failed";
  mode: "outdated" | "missing-and-outdated";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  languages: Array<Pick<AutoTranslateLanguage, "code" | "name">>;
  localizationPath: string;
  model: string;
  result: AdminTranslationRequestResult;
  error: string | null;
  logs: AdminTranslationJobLogEntry[];
};

export type AdminTranslationRuntimeStatus = {
  statuses: AdminLanguageTranslationCacheStatus[];
  job: AdminTranslationJobSnapshot | null;
  updatedAt: string;
};

export type AdminLanguageTranslationCacheStatus = {
  languageCode: string;
  languageName: string;
  cachedPages: number;
  currentPages: number;
  missingPages: number;
  outdatedPages: number;
  totalPages: number;
  sourceLanguage: boolean;
};

export type AdminMarkdownCacheLanguageStatus = {
  cached: boolean;
  contentHash: string;
  headingCount: number;
  htmlBytes: number;
  languageCode: string;
  languageName: string;
  savedAt: string | null;
  sourceLanguage: boolean;
};

export type AdminMarkdownCachePageStatus = {
  cachedVariants: number;
  languages: AdminMarkdownCacheLanguageStatus[];
  path: string;
  slug: string;
  title: string;
  totalVariants: number;
};

export type AdminMarkdownCacheStatus = {
  cacheDirectory: string;
  cachedVariants: number;
  currentSourceEntries: number;
  currentSourceHtmlBytes: number;
  globalEntries: number;
  globalHtmlBytes: number;
  globalStaleEntries: number;
  lastMutation: AdminMarkdownCacheMutation | null;
  otherSourceEntries: number;
  processId: number;
  rendererVersion: string;
  sourcePagesCached: number;
  staleEntries: number;
  totalHtmlBytes: number;
  totalPages: number;
  totalVariants: number;
  translatedVariants: number;
  uncachedVariants: number;
  updatedAt: string;
  pages: AdminMarkdownCachePageStatus[];
};

export type AdminMarkdownCacheMutation = {
  at: string;
  deletedEntries: number;
  reason: string;
  scope: "all" | "page" | "pages";
  target?: string;
};

export type AdminMarkdownCacheWarmResult = {
  cachedVariants: number;
  failedVariants: number;
  failures: Array<{
    error: string;
    languageCode: string;
    slug: string;
  }>;
  renderedVariants: number;
  skippedVariants: number;
  totalPages: number;
  totalVariants: number;
};

export type AdminMarkdownCacheClearResult = {
  clearedEntries: number;
  scope: "all" | "page";
  slug?: string;
};

export type AdminSettings = {
  siteTitle: string;
  siteDescription: string;
  footerText: string;
  startPage: string;
  siteTitleGradientFrom: string;
  siteTitleGradientTo: string;
  docsIconPng16Url: string;
  docsIconPng32Url: string;
  docsIconPng180Url: string;
  docsRefreshIntervalMinutes: number;
  customDomain: string;
  letsEncryptEmail: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubDocsPath: string;
  githubToken: string;
  tokenConfigured: boolean;
  aiChatEnabled: boolean;
  aiChatAssistantName: string;
  aiChatAvatarUrl: string;
  aiChatHeaderSubtitle: string;
  aiChatWelcomeMessage: string;
  aiChatSystemPrompt: string;
  openRouterModel: string;
  openRouterApiKey: string;
  openRouterApiKeyConfigured: boolean;
  autoTranslateEnabled: boolean;
  autoTranslateOpenRouterModel: string;
  autoTranslateRequestTimeoutSeconds: number;
  autoTranslateLanguages: AutoTranslateLanguage[];
  autoTranslateLocalizationPath: string;
  themeLightAccent: string;
  themeLightSurfaceAccent: string;
  themeDarkAccent: string;
  themeDarkSurfaceAccent: string;
  themeCustomCss: string;
};

export type DomainSslCertificateState = "missing" | "valid" | "expiring_soon" | "expired" | "domain_mismatch" | "invalid";

export type DomainSslRuntimeStatus = {
  source: "runtime" | "best-effort";
  configured: boolean;
  customDomain: string;
  letsEncryptEmail: string;
  certificateState: DomainSslCertificateState;
  certificatePresent: boolean;
  certificateValidForDomain: boolean | null;
  certificateExpiresAt: string | null;
  checkedAt: string;
  message: string;
};

export type EditableDoc = {
  title: string;
  description: string;
  path: string;
  slug: string;
  content: string;
  includeInPlaintextExport: boolean;
  commitMessage: string;
};

export type AiChatReply = {
  role: "assistant";
  text: string;
  name?: string;
};
