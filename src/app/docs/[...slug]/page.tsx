import { DocsClient } from "@/components/docs-client";
import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";
import { loadInitialDocsClientData } from "@/lib/docs-initial-data";

type DocsSlugPageProps = {
  params: Promise<{ slug: string[] }>;
};

export async function generateMetadata({ params }: DocsSlugPageProps) {
  const resolved = await params;
  return generateDocsPageMetadata(resolved.slug);
}

export default async function DocsSlugPage({ params }: DocsSlugPageProps) {
  const resolved = await params;
  const initialPath = `/${resolved.slug.join("/")}`;
  const initialData = await loadInitialDocsClientData(initialPath);

  return <DocsClient initialPath={initialPath} {...initialData} />;
}
