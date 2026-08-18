import { type NextRequest } from "next/server";

import { AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME } from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { parseDocsRoutePath } from "@/lib/docs-routing";
import { loadDocsPageForLanguage } from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
import { badRequest, publicTextErrorResponse } from "@/lib/http";
import { canonicalizePublicDocLocator } from "@/lib/public-doc-path";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT_PLAIN_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, must-revalidate",
};

type RawDocBySlugRouteContext = {
  params: Promise<{ slug: string[] }>;
};

export const GET = async (request: NextRequest, context: RawDocBySlugRouteContext): Promise<Response> => {
  try {
    const resolved = await context.params;
    const slug = resolved.slug.join("/").trim();

    if (!slug) {
      throw badRequest("A slug query parameter is required.");
    }
    canonicalizePublicDocLocator({ slug });

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const route = parseDocsRoutePath(slug, store.settings.autoTranslate.languages);
    const requestedLanguageCode =
      route.languageCode ??
      request.nextUrl.searchParams.get("language") ??
      request.cookies.get(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)?.value ??
      undefined;
    const { data: page } = await loadDocsPageForLanguage({
      config,
      locator: canonicalizePublicDocLocator({ slug: route.pagePath.replace(/^\/+/, "") }),
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
    return publicTextErrorResponse(error, { context: "GET /api/docs/raw/[...slug]", headers: TEXT_PLAIN_HEADERS });
  }
};
