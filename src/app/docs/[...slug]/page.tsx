import { DocsClient } from "@/components/docs-client";

type DocsSlugPageProps = {
  params: Promise<{ slug: string[] }>;
};

export default async function DocsSlugPage({ params }: DocsSlugPageProps) {
  const resolved = await params;
  const initialPath = `/${resolved.slug.join("/")}`;

  return <DocsClient initialPath={initialPath} />;
}
