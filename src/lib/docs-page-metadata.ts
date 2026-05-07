import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { headers } from "next/headers";

import { normalizeCustomDomain } from "@/lib/domain-settings";
import { loadGitHubDoc, resolveRuntimeConfig } from "@/lib/github";
import { normalizeStartPage } from "@/lib/start-page";
import { getStore } from "@/lib/store";

const FALLBACK_SITE_TITLE = "Vicky Docs";
const FALLBACK_SITE_DESCRIPTION = "Docs/wiki frontend with navigation, search, editor, and admin appearance settings.";

const normalizeDocsSlug = (value: string): string =>
  value
    .trim()
    .replace(/^\/?docs(?=\/|$)/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

const toDocsPath = (slug: string): string => {
  const normalizedSlug = normalizeDocsSlug(slug);
  return normalizedSlug ? `/docs/${normalizedSlug}` : "/docs";
};

const prettyFromSlug = (slug: string): string => {
  const segment = slug.split("/").filter(Boolean).at(-1) ?? slug;
  return segment.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};

const firstHeaderValue = (value: string | null): string => value?.split(",")[0]?.trim() ?? "";

const defaultProtocolForHost = (host: string): "http" | "https" =>
  host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]") ? "http" : "https";

const resolveRequestOrigin = async (customDomain: string): Promise<string | null> => {
  const normalizedCustomDomain = normalizeCustomDomain(customDomain);
  if (normalizedCustomDomain) {
    return `https://${normalizedCustomDomain}`;
  }

  try {
    const headerStore = await headers();
    const forwardedProto = firstHeaderValue(headerStore.get("x-forwarded-proto"));
    const forwardedHost = firstHeaderValue(headerStore.get("x-forwarded-host"));
    const host = forwardedHost || firstHeaderValue(headerStore.get("host"));

    if (!host) {
      return null;
    }

    return `${forwardedProto || defaultProtocolForHost(host)}://${host}`;
  } catch {
    return null;
  }
};

const absoluteUrl = (origin: string | null, path: string): string => (origin ? `${origin}${path}` : path);

export async function generateDocsPageMetadata(slugSegments?: string[]): Promise<Metadata> {
  noStore();

  try {
    const store = await getStore();
    const requestedSlug = slugSegments?.length
      ? normalizeDocsSlug(slugSegments.join("/"))
      : normalizeStartPage(store.settings.startPage).slice(1);
    const config = resolveRuntimeConfig(store.settings.github);
    const page = await loadGitHubDoc(config, { slug: requestedSlug });
    const title = page.title.trim() || prettyFromSlug(page.slug || requestedSlug) || store.settings.siteTitle || FALLBACK_SITE_TITLE;
    const description = page.description.trim() || store.settings.siteDescription || FALLBACK_SITE_DESCRIPTION;
    const canonicalPath = toDocsPath(page.slug || requestedSlug);
    const canonicalUrl = absoluteUrl(await resolveRequestOrigin(store.settings.domain.customDomain), canonicalPath);

    return {
      title,
      description,
      alternates: {
        canonical: canonicalUrl,
      },
      openGraph: {
        title,
        description,
        url: canonicalUrl,
        type: "article",
      },
    };
  } catch {
    return {};
  }
}
