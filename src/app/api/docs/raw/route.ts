import { type NextRequest } from "next/server";

import { AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME } from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadDocsPageForLanguage } from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
import { publicTextErrorResponse } from "@/lib/http";
import { canonicalizePublicDocLocator } from "@/lib/public-doc-path";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT_PLAIN_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, must-revalidate",
};

export const GET = async (request: NextRequest): Promise<Response> => {
  try {
    const locator = canonicalizePublicDocLocator({ slug: request.nextUrl.searchParams.get("slug") ?? undefined, path: request.nextUrl.searchParams.get("path") ?? undefined });

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const requestedLanguageCode =
      request.nextUrl.searchParams.get("language") ??
      request.cookies.get(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)?.value ??
      undefined;
    const { data: page } = await loadDocsPageForLanguage({
      config,
      locator,
      requestedLanguageCode,
      request,
      signal: request.signal,
      store,
    });

    return new Response(page.markdown, {
      status: 200,
      headers: TEXT_PLAIN_HEADERS,
    });
  } catch (error: unknown) {
    return publicTextErrorResponse(error, { context: "GET /api/docs/raw", headers: TEXT_PLAIN_HEADERS });
  }
};
