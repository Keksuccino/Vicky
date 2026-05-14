import { redirect } from "next/navigation";

import { DocsArticle } from "@/components/docs-article";
import { DocsShell } from "@/components/docs-shell";
import { ErrorState } from "@/components/states";
import { generateDocsPageMetadata } from "@/lib/docs-page-metadata";
import { loadInitialDocsClientData } from "@/lib/docs-initial-data";
import { normalizeStartPage } from "@/lib/start-page";
import { getStore } from "@/lib/store";

export async function generateMetadata() {
  return generateDocsPageMetadata();
}

export default async function DocsIndexPage() {
  const store = await getStore();
  const startPage = normalizeStartPage(store.settings.startPage);
  if (startPage !== "/") {
    redirect(`/docs/${startPage.slice(1)}`);
  }

  const initialData = await loadInitialDocsClientData("/");
  const { page, pageError, ...shellData } = initialData;

  return (
    <DocsShell initialPath="/" {...shellData}>
      {page ? (
        <DocsArticle page={page} />
      ) : (
        <ErrorState title="Unable to load page" message={pageError ?? "The docs start page could not be loaded."} />
      )}
    </DocsShell>
  );
}
