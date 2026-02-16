const DEFAULT_START_PAGE = "/home";
const markdownExtensionRegex = /\.(md|mdx)$/i;

const toDocsRelativePath = (value: string): string => {
  let normalized = value.trim().replace(/\\+/g, "/");

  const hashIndex = normalized.indexOf("#");
  if (hashIndex >= 0) {
    normalized = normalized.slice(0, hashIndex);
  }

  const queryIndex = normalized.indexOf("?");
  if (queryIndex >= 0) {
    normalized = normalized.slice(0, queryIndex);
  }

  normalized = normalized.replace(/^[a-z]+:\/\/[^/]+/i, "");
  normalized = normalized.replace(/^\/?docs(?=\/|$)/i, "");
  normalized = normalized.replace(/^\/+/, "").replace(/\/+$/, "");
  normalized = normalized.replace(markdownExtensionRegex, "");

  if (!normalized) {
    return "";
  }

  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return "";
  }

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "";
  }

  return segments.join("/");
};

export const normalizeStartPage = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_START_PAGE;
  }

  const relativePath = toDocsRelativePath(value);
  if (!relativePath) {
    return DEFAULT_START_PAGE;
  }

  return `/${relativePath}`;
};

export const startPageToDocsHref = (value: unknown): string => {
  const normalized = normalizeStartPage(value);
  return `/docs/${normalized.slice(1)}`;
};

export { DEFAULT_START_PAGE };
