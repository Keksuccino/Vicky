export type ThemeMode = "light" | "dark";

export interface GitHubSettings {
  owner: string;
  repo: string;
  branch: string;
  docsPath: string;
  tokenEncrypted: string | null;
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
}

export interface AutoTranslateSettings {
  enabled: boolean;
  openRouterModel: string;
  languages: AutoTranslateLanguage[];
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

export interface VisitorStatsVisit {
  id: string;
  path: string;
  slug: string;
  title: string;
  visitorId: string;
  visitedAt: string;
}

export interface VisitorStatsStore {
  salt: string;
  updatedAt: string;
  visits: VisitorStatsVisit[];
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
  updatedAt: string;
  scopes: VisitorStatsScopeSummaries;
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

export type PerformanceStatsSource = "server" | "windows-host";

export interface PerformanceStatsSnapshot {
  updatedAt: string;
  source: PerformanceStatsSource;
  sourceLabel: string;
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
  version: 9;
  settings: AppSettings;
  moderators: ModeratorAccount[];
  visitorStats: VisitorStatsStore;
}

export interface GitHubRuntimeConfig {
  owner: string;
  repo: string;
  branch: string;
  docsPath: string;
  token: string;
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
