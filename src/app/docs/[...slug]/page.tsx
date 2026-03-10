import { unstable_noStore as noStore } from "next/cache";
import { notFound } from "next/navigation";

import { DocsClient } from "@/components/docs-client";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadGitHubDoc, resolveRuntimeConfig } from "@/lib/github";
import { ApiError } from "@/lib/http";
import { getStore } from "@/lib/store";

type DocsSlugPageProps = {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<{ raw?: string | string[] }>;
};

function isRawRequest(value: string | string[] | undefined): boolean {
  if (typeof value === "undefined") {
    return false;
  }

  const resolved = Array.isArray(value) ? value[0] ?? "" : value;
  const normalized = resolved.trim().toLowerCase();

  return normalized !== "0" && normalized !== "false";
}

export default async function DocsSlugPage({ params, searchParams }: DocsSlugPageProps) {
  const resolved = await params;
  const initialPath = `/${resolved.slug.join("/")}`;
  const query = await searchParams;

  if (isRawRequest(query.raw)) {
    noStore();

    try {
      const store = await getStore();
      setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
      const config = resolveRuntimeConfig(store.settings.github);
      const page = await loadGitHubDoc(config, { slug: resolved.slug.join("/") });

      return (
        <section className="docs-page">
          <main className="docs-main docs-raw-main" id="main-content">
            <pre className="docs-raw-pre">{page.markdown}</pre>
          </main>
        </section>
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 404) {
        notFound();
      }

      throw error;
    }
  }

  return <DocsClient initialPath={initialPath} />;
}
