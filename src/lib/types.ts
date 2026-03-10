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
  version: 3;
  settings: AppSettings;
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
}
