export type ThemeMode = "light" | "dark" | "custom";
export type StoredThemeMode = "light" | "dark";

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
  headings: MarkdownHeading[];
  updatedAt?: string;
  updatedBy?: string;
};

export type DocSearchResult = {
  title: string;
  path: string;
  slug: string;
  score?: number;
  excerpt?: string;
};

export type AuthUser = {
  role: "admin";
};

export type AdminSettings = {
  siteTitle: string;
  siteDescription: string;
  docsCacheTtlSeconds: number;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubDocsPath: string;
  githubToken: string;
  tokenConfigured: boolean;
};

export type ThemeDefinition = {
  id: string;
  name: string;
  mode: StoredThemeMode;
  isBuiltin: boolean;
  variables: Record<string, string>;
  customCss: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
};

export type ThemeDraft = {
  id?: string;
  name: string;
  mode: StoredThemeMode;
  variables: Array<{ key: string; value: string }>;
  customCss: string;
};

export type EditableDoc = {
  title: string;
  description: string;
  path: string;
  slug: string;
  content: string;
  commitMessage: string;
};
