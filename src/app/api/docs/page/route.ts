import { NextResponse, type NextRequest } from "next/server";

import { AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME } from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadRenderedDocsPageForLanguage } from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
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
    const requestedLanguageCode =
      request.nextUrl.searchParams.get("language") ??
      request.cookies.get(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)?.value ??
      undefined;
    const { data: page } = await loadRenderedDocsPageForLanguage({
      config,
      locator: { slug, path },
      requestedLanguageCode,
      store,
    });

    return NextResponse.json({ page });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
