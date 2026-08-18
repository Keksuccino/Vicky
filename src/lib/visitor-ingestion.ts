import { z } from "zod";
import type { NextRequest } from "next/server";

import { getCachedGitHubDocPage } from "@/lib/github";
import { ApiError, badRequest, notFound, parseBoundedJsonBody } from "@/lib/http";
import { normalizeVisitorPageIdentity } from "@/lib/visitors";
import type { GitHubDocTreeItem, GitHubRuntimeConfig, VisitorPageIdentity } from "@/lib/types";

const MAX_BODY_BYTES = 2_048;
const MAX_EVENT_ID_LENGTH = 64;
const MAX_SLUG_LENGTH = 512;
const MAX_PATH_LENGTH = MAX_SLUG_LENGTH + 1;
const MAX_TITLE_LENGTH = 256;
const MAX_SLUG_SEGMENT_LENGTH = 128;
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UNSAFE_PATH_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\?#%<>"`|{}\[\]^]/u;
const UNSAFE_TITLE_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Docs-tree arrays are reused by the TTL cache. A WeakMap makes repeated visit lookup O(1)
// without retaining expired trees or introducing another invalidation path.
const knownPageIndexes = new WeakMap<GitHubDocTreeItem[], Map<string, GitHubDocTreeItem>>();

const isSafeSlug = (value: string): boolean => {
  if (!value || value.length > MAX_SLUG_LENGTH || value !== value.trim()) {
    return false;
  }
  if (value.startsWith("/") || value.endsWith("/") || UNSAFE_PATH_CHARACTER_PATTERN.test(value)) {
    return false;
  }

  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment.length <= MAX_SLUG_SEGMENT_LENGTH && segment === segment.trim() && segment !== "." && segment !== "..");
};

const isSafePath = (value: string): boolean => value.length <= MAX_PATH_LENGTH && value.startsWith("/") && isSafeSlug(value.slice(1));

const isSafeTitle = (value: string): boolean => value.length <= MAX_TITLE_LENGTH && value === value.trim() && !UNSAFE_TITLE_CHARACTER_PATTERN.test(value);

// `title` remains optional for compatibility with older clients, but only the server-resolved title is persisted.
const visitSchema = z.object({ eventId: z.string().min(1).max(MAX_EVENT_ID_LENGTH).regex(EVENT_ID_PATTERN, "Invalid analytics event ID."), path: z.string().refine(isSafePath, "Invalid docs page path."), slug: z.string().refine(isSafeSlug, "Invalid docs page slug."), title: z.string().refine(isSafeTitle, "Invalid docs page title.").optional() }).strict();

export type VisitorIngestionPayload = z.infer<typeof visitSchema>;

export const assertVisitorIngestionSameSite = (request: NextRequest): void => {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") {
    throw new ApiError(403, "Cross-site analytics requests are not allowed.");
  }

  const origin = request.headers.get("origin")?.trim();
  if (!origin) {
    return;
  }

  let originHost = "";
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
      throw new Error("Unsupported origin protocol.");
    }
    originHost = parsedOrigin.host.toLowerCase();
  } catch {
    throw new ApiError(403, "Invalid analytics request origin.");
  }

  const allowedHosts = new Set([request.nextUrl.host.toLowerCase(), request.headers.get("host")?.trim().toLowerCase()].filter((value): value is string => Boolean(value)));
  if (!allowedHosts.has(originHost)) {
    throw new ApiError(403, "Cross-origin analytics requests are not allowed.");
  }
};

export const parseVisitorIngestionRequest = async (request: NextRequest): Promise<VisitorIngestionPayload> => {
  const body = await parseBoundedJsonBody<unknown>(request, { bodyName: "Analytics", maxBytes: MAX_BODY_BYTES });
  return visitSchema.parse(body);
};

const sanitizeAuthoritativeTitle = (value: string): string => {
  const withoutControls = value.normalize("NFC").replace(UNSAFE_TITLE_CHARACTER_PATTERN, " ").replace(/\s+/g, " ").trim();
  return Array.from(withoutControls).slice(0, MAX_TITLE_LENGTH).join("");
};

const getKnownPageIndex = (tree: GitHubDocTreeItem[]): Map<string, GitHubDocTreeItem> => {
  const cached = knownPageIndexes.get(tree);
  if (cached) {
    return cached;
  }
  const index = new Map(tree.map((item) => [item.slug, item]));
  knownPageIndexes.set(tree, index);
  return index;
};

export const resolveKnownVisitorPageIdentity = (payload: VisitorIngestionPayload, tree: GitHubDocTreeItem[], config: GitHubRuntimeConfig): VisitorPageIdentity => {
  const itemBySlug = getKnownPageIndex(tree).get(payload.slug);
  if (!itemBySlug) {
    throw notFound("Docs page not found.");
  }

  const canonicalPath = `/${itemBySlug.slug}`;
  if (payload.path !== canonicalPath) {
    throw badRequest("Docs page path and slug do not identify the same page.");
  }

  const cachedPage = getCachedGitHubDocPage(config, itemBySlug.path);
  const authoritativeTitle = sanitizeAuthoritativeTitle(cachedPage?.title || itemBySlug.name);
  return normalizeVisitorPageIdentity({ path: canonicalPath, slug: itemBySlug.slug, title: authoritativeTitle });
};
