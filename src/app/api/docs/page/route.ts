import { NextResponse, type NextRequest } from "next/server";

import { loadGitHubDoc, resolveRuntimeConfig } from "@/lib/github";
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
    const config = resolveRuntimeConfig(store.settings.github);
    const page = await loadGitHubDoc(config, { slug, path });

    return NextResponse.json({ page });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
