import type { ReactNode } from "react";

import { DocsPageErrorMessageProvider } from "@/components/docs-page-error";
import { DocsShell } from "@/components/docs-shell";
import { docsRequestPath, loadDocsRouteData, resolveDocsIndexHref } from "@/lib/docs-initial-data";

type DocsLayoutProps = {
  children: ReactNode;
  params: Promise<{ slug?: string[] }>;
};

/**
 * The docs shell lives in this layout rather than in the page, so the not-found and error
 * boundaries of the page segment replace only the article: a missing or failing page keeps the
 * sidebar while still answering with a real 404 or 500 status.
 */
export default async function DocsLayout({ children, params }: DocsLayoutProps) {
  const { slug } = await params;
  const requestedPath = docsRequestPath(slug);
  // The page forwards the bare docs index to the start page, so there is no shell to load. The
  // forward must come from the page, which alone sees the query (and with it `?raw`).
  if (requestedPath === "/" && (await resolveDocsIndexHref())) {
    return <>{children}</>;
  }

  const { page, pageError, shell } = await loadDocsRouteData(requestedPath);

  return (
    <DocsShell initialPath={requestedPath} {...shell}>
      <DocsPageErrorMessageProvider message={page ? undefined : pageError}>{children}</DocsPageErrorMessageProvider>
    </DocsShell>
  );
}
