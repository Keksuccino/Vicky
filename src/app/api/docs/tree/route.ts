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
import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";
import type { AutoTranslateLanguage, GitHubDocTreeItem } from "@/lib/types";

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
    `[auto-translate] Failed to translate docs sidebar titles to ${language.name} (${language.code}); serving source English titles. ${message}`,
  );
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
    const shouldTranslate = shouldTranslateAutoTranslateLanguage(store.settings.autoTranslate, language);
    const apiKeyEncrypted = store.settings.openRouter.apiKeyEncrypted;
    const model = store.settings.autoTranslate.openRouterModel.trim();

    let items: GitHubDocTreeItem[] = sourceItems;

    if (!shouldTranslate) {
      return NextResponse.json({ items });
    }

    if (!apiKeyEncrypted || !model) {
      warnAutoTranslateFallback(language, new Error("Auto-translate is not fully configured."));
      return NextResponse.json({ items });
    }

    try {
      items = await translateGitHubDocTreeTitles({
        apiKey: decryptSecret(apiKeyEncrypted).trim(),
        config,
        items: sourceItems,
        language,
        model,
        origin: resolveRequestOrigin(request),
        pages,
        settings: store.settings.autoTranslate,
        siteTitle: store.settings.siteTitle || "Vicky Docs",
      });
    } catch (translationError: unknown) {
      warnAutoTranslateFallback(language, translationError);
    }

    return NextResponse.json({ items });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
