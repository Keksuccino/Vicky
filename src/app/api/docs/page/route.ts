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
import { badRequest, errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";
import { recordDocPageVisit } from "@/lib/visitors";
import type { AutoTranslateLanguage } from "@/lib/types";

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

const warnAutoTranslateFallback = (language: AutoTranslateLanguage, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[auto-translate] Failed to translate docs page to ${language.name} (${language.code}); serving source English page. ${message}`,
  );
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
    const apiKeyEncrypted = store.settings.openRouter.apiKeyEncrypted;
    const model = store.settings.autoTranslate.openRouterModel.trim();

    if (!shouldTranslate) {
      return NextResponse.json({ page });
    }

    if (!apiKeyEncrypted || !model) {
      warnAutoTranslateFallback(language, new Error("Auto-translate is not fully configured."));
      return NextResponse.json({ page });
    }

    try {
      const translatedPage = await translateGitHubDocPage({
        apiKey: decryptSecret(apiKeyEncrypted).trim(),
        config,
        language,
        model,
        origin: resolveRequestOrigin(request),
        settings: store.settings.autoTranslate,
        siteTitle: store.settings.siteTitle || "Vicky Docs",
        sourcePage: page,
      });

      return NextResponse.json({ page: { ...translatedPage, sourceHeadings: page.headings } });
    } catch (translationError: unknown) {
      warnAutoTranslateFallback(language, translationError);
      return NextResponse.json({ page });
    }
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
