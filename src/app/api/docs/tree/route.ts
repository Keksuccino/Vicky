import { NextResponse, type NextRequest } from "next/server";

import {
  AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME,
  resolveAutoTranslateLanguage,
  shouldTranslateAutoTranslateLanguage,
} from "@/lib/auto-translate";
import { translateGitHubDocTreeTitles } from "@/lib/auto-translate-server";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { decryptSecret } from "@/lib/encryption";
import { listMarkdownDocsTreePagesWithTitles, resolveRuntimeConfig } from "@/lib/github";
import { ApiError, errorResponse } from "@/lib/http";
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
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const { items: sourceItems, pages } = await listMarkdownDocsTreePagesWithTitles(config);
    const requestedLanguageCode =
      request.nextUrl.searchParams.get("language") ??
      request.cookies.get(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)?.value ??
      undefined;
    const language = resolveAutoTranslateLanguage(store.settings.autoTranslate, requestedLanguageCode);

    if (
      shouldTranslateAutoTranslateLanguage(store.settings.autoTranslate, language) &&
      (!store.settings.openRouter.apiKeyEncrypted || !store.settings.autoTranslate.openRouterModel.trim())
    ) {
      throw new ApiError(503, "Auto-translate is not fully configured.");
    }

    const items = shouldTranslateAutoTranslateLanguage(store.settings.autoTranslate, language)
      ? await translateGitHubDocTreeTitles({
          apiKey: decryptSecret(store.settings.openRouter.apiKeyEncrypted).trim(),
          config,
          items: sourceItems,
          language,
          model: store.settings.autoTranslate.openRouterModel,
          origin: resolveRequestOrigin(request),
          pages,
          settings: store.settings.autoTranslate,
          siteTitle: store.settings.siteTitle || "Vicky Docs",
        })
      : sourceItems;

    return NextResponse.json({ items });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
