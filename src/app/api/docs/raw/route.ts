import { type NextRequest } from "next/server";

import { AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME, DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE } from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { rawDocsHref } from "@/lib/docs-routing";
import { loadDocsPageForLanguage } from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
import { publicTextErrorResponse } from "@/lib/http";
import { canonicalizePublicDocLocator } from "@/lib/public-doc-path";
import { withPublicDocsAdmission } from "@/lib/public-docs-admission";
import { startPageToDocsHref } from "@/lib/start-page";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT_PLAIN_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, must-revalidate",
};

export const GET = async (request: NextRequest): Promise<Response> => {
  try {
    const { searchParams } = request.nextUrl;
    const store = await getStore();
    // `/docs?raw=1` is rewritten here without a page. Like the HTML docs index, it forwards to the
    // start page, here to its raw Markdown URL. The Location stays relative to the visitor's origin.
    if (!searchParams.has("slug") && !searchParams.has("path")) {
      const startPageHref = startPageToDocsHref(store.settings.startPage, DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE);
      return new Response(null, { status: 307, headers: { ...TEXT_PLAIN_HEADERS, Location: rawDocsHref(startPageHref, searchParams) } });
    }

    const locator = canonicalizePublicDocLocator({ slug: searchParams.get("slug") ?? undefined, path: searchParams.get("path") ?? undefined });
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const requestedLanguageCode =
      request.nextUrl.searchParams.get("language") ??
      request.cookies.get(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)?.value ??
      undefined;
    const { data: page } = await withPublicDocsAdmission(request, () =>
      loadDocsPageForLanguage({ config, locator, requestedLanguageCode, signal: request.signal, store }),
    );

    return new Response(page.markdown, {
      status: 200,
      headers: TEXT_PLAIN_HEADERS,
    });
  } catch (error: unknown) {
    return publicTextErrorResponse(error, { context: "GET /api/docs/raw", headers: TEXT_PLAIN_HEADERS });
  }
};
