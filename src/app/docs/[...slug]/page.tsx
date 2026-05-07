import { DocsClient } from "@/components/docs-client";
import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";

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

  return <DocsClient initialPath={initialPath} />;
}
