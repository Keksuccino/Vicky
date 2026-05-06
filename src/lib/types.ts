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
  openRouterApiKeyEncrypted: string | null;
  systemPrompt: string;
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

export interface VisitorStatsPageBucket {
  path: string;
  slug: string;
  title: string;
  visitorIds: string[];
  updatedAt: string;
}

export interface VisitorStatsBucket {
  visitorIds: string[];
  pages: Record<string, VisitorStatsPageBucket>;
}

export interface VisitorStatsStore {
  salt: string;
  updatedAt: string;
  allTime: VisitorStatsBucket;
  daily: Record<string, VisitorStatsBucket>;
  weekly: Record<string, VisitorStatsBucket>;
  monthly: Record<string, VisitorStatsBucket>;
  yearly: Record<string, VisitorStatsBucket>;
}

export interface VisitorStatsPeriodSummary {
  key: string;
  label: string;
  visitors: number;
  current: boolean;
}

export interface VisitorStatsPageSummary {
  path: string;
  slug: string;
  title: string;
  visitors: number;
}

export interface VisitorStatsScopeSummary {
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
  aiChat: AiChatSettings;
  theme: ThemeCustomizationSettings;
  updatedAt: string;
}

export interface DocsStore {
  version: 5;
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
