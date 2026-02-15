export type ThemeMode = "light" | "dark";

export type ThemeVariables = Record<string, string>;

export interface ThemeDefinition {
  id: string;
  name: string;
  mode: ThemeMode;
  isBuiltin: boolean;
  variables: ThemeVariables;
  customCss: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubSettings {
  owner: string;
  repo: string;
  branch: string;
  docsPath: string;
  tokenEncrypted: string | null;
}

export interface AppSettings {
  siteTitle: string;
  siteDescription: string;
  github: GitHubSettings;
  activeThemeId: string;
  updatedAt: string;
}

export interface DocsStore {
  version: 1;
  settings: AppSettings;
  themes: ThemeDefinition[];
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
  updatedAt?: string;
  updatedBy?: string;
}

export interface SaveGitHubDocInput {
  slug?: string;
  path?: string;
  title?: string;
  description?: string;
  content?: string;
  markdown?: string;
  commitMessage?: string;
}

export interface SaveGitHubDocResult {
  path: string;
  slug: string;
  commitSha: string;
}
