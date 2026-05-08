import { NextResponse, type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadGitHubDocMetadata, resolveRuntimeConfig } from "@/lib/github";
import { badRequest, errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const slug = request.nextUrl.searchParams.get("slug") ?? undefined;
    const path = request.nextUrl.searchParams.get("path") ?? undefined;

    if (!slug && !path) {
      throw badRequest("A slug or path query parameter is required.");
    }

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const metadata = await loadGitHubDocMetadata(config, { slug, path });

    return NextResponse.json({ metadata });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
