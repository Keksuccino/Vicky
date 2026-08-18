import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { headers } from "next/headers";

import { docsHrefForPagePath, parseDocsRoutePath } from "@/lib/docs-routing";
import { loadDocsPageForLanguage } from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
import { resolveRequestOrigin } from "@/lib/request-origin-policy.mjs";
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

const prettyFromSlug = (slug: string): string => {
  const segment = slug.split("/").filter(Boolean).at(-1) ?? slug;
  return segment.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};

const absoluteUrl = (origin: string | null, path: string): string => (origin ? `${origin}${path}` : path);

export async function generateDocsPageMetadata(slugSegments?: string[]): Promise<Metadata> {
  noStore();

  try {
    const store = await getStore();
    const rawRequestedSlug = slugSegments?.length
      ? normalizeDocsSlug(slugSegments.join("/"))
      : normalizeStartPage(store.settings.startPage).slice(1);
    const route = parseDocsRoutePath(rawRequestedSlug, store.settings.autoTranslate.languages);
    const requestedSlug = route.pagePath.slice(1);
    const config = resolveRuntimeConfig(store.settings.github);
    const headerStore = await headers();
    const origin = resolveRequestOrigin({ customDomain: store.settings.domain.customDomain, headers: headerStore });
    const { data: page, language } = await loadDocsPageForLanguage({
      config,
      locator: { slug: requestedSlug },
      requestedLanguageCode: route.languageCode,
      request: { headers: headerStore },
      store,
    });
    const title = page.title.trim() || prettyFromSlug(page.slug || requestedSlug) || store.settings.siteTitle || FALLBACK_SITE_TITLE;
    const description = page.description.trim() || store.settings.siteDescription || FALLBACK_SITE_DESCRIPTION;
    const canonicalPath = docsHrefForPagePath(page.slug || requestedSlug, language.code);
    const canonicalUrl = absoluteUrl(origin, canonicalPath);

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
