import { DocsClient } from "@/components/docs-client";
import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";
import { loadInitialDocsClientData } from "@/lib/docs-initial-data";

export async function generateMetadata() {
  return generateDocsPageMetadata();
}

export default async function DocsIndexPage() {
  const initialData = await loadInitialDocsClientData("/");

  return <DocsClient initialPath="/" {...initialData} />;
}
