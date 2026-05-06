import { NextResponse, type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadGitHubDoc, resolveRuntimeConfig } from "@/lib/github";
import { badRequest, errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";
import { recordDocPageVisit } from "@/lib/visitors";

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
    const page = await loadGitHubDoc(config, { slug, path });
    try {
      await recordDocPageVisit(request, page);
    } catch (visitError: unknown) {
      const message = visitError instanceof Error ? visitError.message : String(visitError);
      console.warn(`[visitors] Failed to record docs page visit: ${message}`);
    }

    return NextResponse.json({ page });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
