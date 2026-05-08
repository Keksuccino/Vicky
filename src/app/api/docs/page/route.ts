import { NextResponse, type NextRequest } from "next/server";

import { AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME } from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadDocsPageForLanguage } from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
import { badRequest, errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resolveRequestOrigin = (request: NextRequest): string => {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
};

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
    const { data: page } = await loadDocsPageForLanguage({
      config,
      locator: { slug, path },
      origin: resolveRequestOrigin(request),
      requestedLanguageCode,
      store,
    });

    return NextResponse.json({ page });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
