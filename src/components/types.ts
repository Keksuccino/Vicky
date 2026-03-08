export type ThemeMode = "light" | "dark";

export type ThemeCustomization = {
  useSharedAccent: boolean;
  sharedAccent: string;
  sharedSurfaceAccent: string;
  lightAccent: string;
  lightSurfaceAccent: string;
  darkAccent: string;
  darkSurfaceAccent: string;
  customCss: string;
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
  anchor?: string;
};

export type AuthUser = {
  role: "admin";
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
  docsCacheTtlSeconds: number;
  customDomain: string;
  letsEncryptEmail: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubDocsPath: string;
  githubToken: string;
  tokenConfigured: boolean;
  themeUseSharedAccent: boolean;
  themeSharedAccent: string;
  themeSharedSurfaceAccent: string;
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
  commitMessage: string;
};
