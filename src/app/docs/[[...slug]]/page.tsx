import { notFound } from "next/navigation";

import { DocsArticle } from "@/components/docs-article";
import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";
import { docsRequestPath, loadDocsRouteData } from "@/lib/docs-initial-data";

type DocsPageProps = {
  params: Promise<{ slug?: string[] }>;
};

export async function generateMetadata({ params }: DocsPageProps) {
  const { slug } = await params;
  return generateDocsPageMetadata(slug);
}

export default async function DocsPage({ params }: DocsPageProps) {
  const { slug } = await params;
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
