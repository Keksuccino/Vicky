import { NextResponse, type NextRequest } from "next/server";

import { AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME } from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadDocsTreeForLanguage } from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const requestedLanguageCode =
      request.nextUrl.searchParams.get("language") ??
      request.cookies.get(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)?.value ??
      undefined;
    const waitForTitleIndex = request.nextUrl.searchParams.get("waitForTitles") === "1";
    const { data: items, titlesPending } = await loadDocsTreeForLanguage({
      config,
      requestedLanguageCode,
      request,
      store,
      waitForTitleIndex,
    });

    return NextResponse.json({ items, titlesPending: Boolean(titlesPending) });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
