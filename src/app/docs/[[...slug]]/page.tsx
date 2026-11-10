import { notFound, redirect } from "next/navigation";

import { DocsArticle } from "@/components/docs-article";
import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";
import { docsRequestPath, loadDocsRouteData, resolveDocsIndexHref } from "@/lib/docs-initial-data";
import { rawDocsHref } from "@/lib/docs-routing";

type DocsSearchParams = Record<string, string | string[] | undefined>;

type DocsPageProps = {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<DocsSearchParams>;
};

const toUrlSearchParams = (searchParams: DocsSearchParams): URLSearchParams => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const item of Array.isArray(value) ? value : [value ?? ""]) {
      query.append(key, item);
    }
  }
  return query;
};

const docsHref = (slug: string[] | undefined): string => (slug?.length ? `/docs/${slug.map(encodeURIComponent).join("/")}` : "/docs");

export async function generateMetadata({ params }: DocsPageProps) {
  const { slug } = await params;
  return generateDocsPageMetadata(slug);
}

/**
 * next.config.ts rewrites `?raw=<value>` docs URLs to the raw Markdown route before they reach this
 * page, but rewrite conditions never match an empty query value. The bare `?raw` form therefore
 * arrives here and is forwarded to the same URL with `raw=1`, keeping its other query parameters.
 * The bare docs index forwards to the start page, or to the start page's raw Markdown for `?raw`.
 */
export default async function DocsPage({ params, searchParams }: DocsPageProps) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const raw = query.raw !== undefined;
  const startPageHref = slug?.length ? null : await resolveDocsIndexHref();
  if (startPageHref) {
    redirect(raw ? rawDocsHref(startPageHref, toUrlSearchParams(query)) : startPageHref);
  }
  if (raw) {
    redirect(rawDocsHref(docsHref(slug), toUrlSearchParams(query)));
  }

  const { page, pageErrorStatus } = await loadDocsRouteData(docsRequestPath(slug));

  if (page) {
    return <DocsArticle page={page} />;
  }

  if (pageErrorStatus === 404) {
    notFound();
  }

  // A page can only set its HTTP status by interrupting the render: notFound() answers 404 and
  // a thrown error answers 500. Both boundaries render inside the docs layout's shell. The
  // message is for server logs only; the layout already supplies the visitor-facing text.
  throw new Error(`Docs page could not be served (status ${pageErrorStatus ?? 500}).`);
}
