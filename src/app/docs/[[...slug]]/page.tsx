import { notFound, redirect } from "next/navigation";

import { DocsArticle } from "@/components/docs-article";
import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";
import { docsRequestPath, loadDocsRouteData } from "@/lib/docs-initial-data";

type DocsSearchParams = Record<string, string | string[] | undefined>;

type DocsPageProps = {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<DocsSearchParams>;
};

/**
 * next.config.ts rewrites `?raw=<value>` docs URLs to the raw Markdown route before they reach this
 * page, but rewrite conditions never match an empty query value. The bare `?raw` form therefore
 * arrives here and is forwarded to the same URL with `raw=1`, keeping its other query parameters.
 */
const rawDocsHref = (slug: string[] | undefined, searchParams: DocsSearchParams): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const item of Array.isArray(value) ? value : [value ?? ""]) {
      query.append(key, item);
    }
  }
  query.set("raw", "1");

  const path = slug?.length ? `/${slug.map(encodeURIComponent).join("/")}` : "";
  return `/docs${path}?${query}`;
};

export async function generateMetadata({ params }: DocsPageProps) {
  const { slug } = await params;
  return generateDocsPageMetadata(slug);
}

export default async function DocsPage({ params, searchParams }: DocsPageProps) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  if (query.raw !== undefined) {
    redirect(rawDocsHref(slug, query));
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
