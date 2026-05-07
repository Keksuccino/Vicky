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
  headings: MarkdownHeading[];
  includeInPlaintextExport: boolean;
  updatedAt?: string;
  updatedBy?: string;
};

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

export type DocsRefreshResult = {
  pageCount: number;
  fetchedAt: string;
  expiresAt: string;
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
  autoTranslateLanguages: AutoTranslateLanguage[];
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
