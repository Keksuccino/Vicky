import { NextResponse, type NextRequest } from "next/server";

import {
  AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME,
  resolveAutoTranslateLanguage,
  shouldTranslateAutoTranslateLanguage,
} from "@/lib/auto-translate";
import { translateGitHubDocPage } from "@/lib/auto-translate-server";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { decryptSecret } from "@/lib/encryption";
import { loadGitHubDoc, resolveRuntimeConfig } from "@/lib/github";
import { ApiError, badRequest, errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";
import { recordDocPageVisit } from "@/lib/visitors";

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
    const page = await loadGitHubDoc(config, { slug, path });
    try {
      await recordDocPageVisit(request, page);
    } catch (visitError: unknown) {
      const message = visitError instanceof Error ? visitError.message : String(visitError);
      console.warn(`[visitors] Failed to record docs page visit: ${message}`);
    }

    const requestedLanguageCode =
      request.nextUrl.searchParams.get("language") ??
      request.cookies.get(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)?.value ??
      undefined;
    const language = resolveAutoTranslateLanguage(store.settings.autoTranslate, requestedLanguageCode);
    const shouldTranslate = shouldTranslateAutoTranslateLanguage(store.settings.autoTranslate, language);

    if (
      shouldTranslate &&
      (!store.settings.openRouter.apiKeyEncrypted || !store.settings.autoTranslate.openRouterModel.trim())
    ) {
      throw new ApiError(503, "Auto-translate is not fully configured.");
    }

    const translatedPage = shouldTranslate
      ? await translateGitHubDocPage({
          apiKey: decryptSecret(store.settings.openRouter.apiKeyEncrypted).trim(),
          config,
          language,
          model: store.settings.autoTranslate.openRouterModel,
          origin: resolveRequestOrigin(request),
          settings: store.settings.autoTranslate,
          siteTitle: store.settings.siteTitle || "Vicky Docs",
          sourcePage: page,
        })
      : page;

    return NextResponse.json({ page: translatedPage });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
