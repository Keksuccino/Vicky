import { NextResponse, type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadPublicGitHubDocMetadata, resolveRuntimeConfig } from "@/lib/github";
import { errorResponse } from "@/lib/http";
import { canonicalizePublicDocLocator } from "@/lib/public-doc-path";
import { withPublicDocsAdmission } from "@/lib/public-docs-admission";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const locator = canonicalizePublicDocLocator({ slug: request.nextUrl.searchParams.get("slug") ?? undefined, path: request.nextUrl.searchParams.get("path") ?? undefined });

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const metadata = await withPublicDocsAdmission(request, () => loadPublicGitHubDocMetadata(config, locator, { signal: request.signal }));

    return NextResponse.json({ metadata });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
