import path from "node:path";

import { badRequest } from "@/lib/http";

export type CanonicalPublicDocLocator =
  | { kind: "path"; path: string }
  | { kind: "slug"; slug: string };

const MAX_PUBLIC_DOC_PATH_LENGTH = 512;
const MAX_PUBLIC_DOC_PATH_SEGMENTS = 32;
const MAX_PUBLIC_DOC_SEGMENT_LENGTH = 128;
const markdownExtensionRegex = /\.(md|mdx)$/i;
const unsafePathCharacterRegex = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\\?#]/u;

const canonicalizePublicDocPathValue = (value: string): string => {
  const normalized = value.normalize("NFC").trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    throw badRequest("A document slug or path is required.");
  }

  if (normalized.length > MAX_PUBLIC_DOC_PATH_LENGTH || unsafePathCharacterRegex.test(normalized)) {
    throw badRequest("Invalid document path.");
  }

  const segments = normalized.split("/");
  if (segments.length > MAX_PUBLIC_DOC_PATH_SEGMENTS) {
    throw badRequest("Invalid document path.");
  }

  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.length > MAX_PUBLIC_DOC_SEGMENT_LENGTH) {
      throw badRequest("Invalid document path.");
    }
  }

  return segments.join("/");
};

export const canonicalizePublicDocLocator = (locator: { path?: string; slug?: string }): CanonicalPublicDocLocator => {
  const hasPath = Boolean(locator.path?.trim());
  const hasSlug = Boolean(locator.slug?.trim());
  if (hasPath === hasSlug) {
    throw badRequest("Provide exactly one document slug or path.");
  }

  if (hasPath) {
    const normalizedPath = canonicalizePublicDocPathValue(locator.path as string);
    const extension = path.posix.extname(normalizedPath);
    if (extension && !markdownExtensionRegex.test(normalizedPath)) {
      throw badRequest("Document paths must end with .md or .mdx.");
    }

    return { kind: "path", path: normalizedPath };
  }

  const slug = canonicalizePublicDocPathValue(locator.slug as string).replace(markdownExtensionRegex, "");
  if (!slug) {
    throw badRequest("A document slug is required.");
  }
  return { kind: "slug", slug };
};
