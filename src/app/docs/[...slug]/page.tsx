import { DocsArticle } from "@/components/docs-article";
import { DocsShell } from "@/components/docs-shell";
import { ErrorState } from "@/components/states";
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
  const { page, pageError, ...shellData } = initialData;

  return (
    <DocsShell initialPath={initialPath} {...shellData}>
      {page ? (
        <DocsArticle page={page} />
      ) : (
        <ErrorState title="Unable to load page" message={pageError ?? "The requested docs page could not be loaded."} />
      )}
    </DocsShell>
  );
}
