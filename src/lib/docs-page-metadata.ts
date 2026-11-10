import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { headers } from "next/headers";

import { docsRequestPath, loadDocsRouteData } from "@/lib/docs-initial-data";
import { docsHrefForPagePath } from "@/lib/docs-routing";
import { resolveRequestOrigin } from "@/lib/request-origin-policy.mjs";
import { getStore } from "@/lib/store";

const FALLBACK_SITE_TITLE = "Vicky Docs";
const FALLBACK_SITE_DESCRIPTION = "Docs/wiki frontend with navigation, search, editor, and admin appearance settings.";

const prettyFromSlug = (slug: string): string => {
  const segment = slug.split("/").filter(Boolean).at(-1) ?? slug;
  return segment.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};

const absoluteUrl = (origin: string | null, path: string): string => (origin ? `${origin}${path}` : path);

/**
 * Metadata of a docs route, taken from the request's single route load (`loadDocsRouteData`), so
 * it costs neither a second page load nor a second admission permit. A route without a page
 * (missing or failed) gets the defaults. The bare docs index is left to the layout, which
 * forwards it to the start page.
 */
export async function generateDocsPageMetadata(slugSegments?: string[]): Promise<Metadata> {
  noStore();
  if (!slugSegments?.length) {
    return {};
  }

  const { page, shell } = await loadDocsRouteData(docsRequestPath(slugSegments));
  if (!page) {
    return {};
  }

  try {
    const store = await getStore();
    const origin = resolveRequestOrigin({ customDomain: store.settings.domain.customDomain, headers: await headers() });
    const title = page.title.trim() || prettyFromSlug(page.slug) || store.settings.siteTitle || FALLBACK_SITE_TITLE;
    const description = page.description.trim() || store.settings.siteDescription || FALLBACK_SITE_DESCRIPTION;
    const canonicalUrl = absoluteUrl(origin, docsHrefForPagePath(page.slug, shell.initialPageLanguageCode ?? shell.initialLanguageCode));

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
