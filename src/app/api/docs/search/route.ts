import { NextResponse, type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { resolveRuntimeConfig } from "@/lib/github";
import { searchDocsCorpus } from "@/lib/docs-search";
import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 50);

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const results = await searchDocsCorpus(config, query, { limit });

    return NextResponse.json({
      query,
      results,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
