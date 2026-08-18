import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { listMarkdownDocsTree, resolveRuntimeConfig } from "@/lib/github";
import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";
import { loadVisitorStatsSummary } from "@/lib/visitors";
import type { DocsStore, VisitorPageIdentity } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loadKnownPages = async (store: DocsStore): Promise<VisitorPageIdentity[]> => {
  try {
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const tree = await listMarkdownDocsTree(config);

    return tree.map((item) => ({
      path: `/${item.slug}`,
      slug: item.slug,
      title: item.name,
    }));
  } catch {
    return [];
  }
};

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const store = await getStore();
    const knownPages = await loadKnownPages(store);
    return NextResponse.json({ stats: await loadVisitorStatsSummary(new Date(), knownPages) });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
