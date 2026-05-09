import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import {
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguage,
} from "@/lib/auto-translate";
import {
  formatAutoTranslateLanguageForLog,
  getAutoTranslateErrorMessage,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import { translateMissingGitHubDocPages } from "@/lib/auto-translate-server";
import { requireAdminRequest } from "@/lib/auth";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { isCircleFlagIconId } from "@/lib/circle-flags";
import { decryptSecret } from "@/lib/encryption";
import { listMarkdownDocsTreePagesWithTitles, resolveRuntimeConfig } from "@/lib/github";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { getStore } from "@/lib/store";
import type { AutoTranslateLanguage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestTranslationsSchema = z
  .object({
    language: z
      .object({
        name: z.string().min(1, "Language name is required."),
        code: z.string().min(1, "Language code is required."),
        icon: z
          .string()
          .min(1, "Language icon is required.")
          .refine(isCircleFlagIconId, "Language icon must be a Circle Flags icon ID."),
      })
      .strict(),
  })
  .strict();

const resolveRequestOrigin = (request: NextRequest): string => {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
};

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  let requestLanguage: AutoTranslateLanguage | null = null;

  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await parseJsonBody<unknown>(request);
    const payload = requestTranslationsSchema.parse(body);
    const language = normalizeAutoTranslateLanguage(payload.language);
    requestLanguage = language;

    if (!language) {
      throw badRequest("A valid auto-translate language is required.");
    }

    if (isDefaultAutoTranslateLanguageCode(language.code)) {
      throw badRequest("The default source language does not need translated pages.");
    }

    const store = await getStore();
    const apiKeyEncrypted = store.settings.openRouter.apiKeyEncrypted;
    const model = store.settings.autoTranslate.openRouterModel.trim();

    if (!apiKeyEncrypted || !model) {
      throw badRequest("Auto-translate is not fully configured.");
    }

    const apiKey = decryptSecret(apiKeyEncrypted).trim();
    if (!apiKey) {
      throw badRequest("Auto-translate is not fully configured.");
    }

    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const { pages } = await listMarkdownDocsTreePagesWithTitles(config, { bypassCache: true });
    logAutoTranslateInfo("Admin requested all-pages translation", {
      language: formatAutoTranslateLanguageForLog(language),
      totalPages: pages.length,
      model,
    });

    const result = await translateMissingGitHubDocPages({
      apiKey,
      config,
      language,
      model,
      origin: resolveRequestOrigin(request),
      pages,
      settings: {
        ...store.settings.autoTranslate,
        enabled: true,
      },
      siteTitle: store.settings.siteTitle || "Vicky Docs",
    });

    logAutoTranslateInfo("Admin all-pages translation request finished", {
      language: formatAutoTranslateLanguageForLog(language),
      totalPages: result.totalPages,
      cachedPages: result.cachedPages,
      requestedPages: result.requestedPages,
      translatedPages: result.translatedPages,
      failedPages: result.failedPages,
      model,
    });

    return NextResponse.json({ result }, { status: result.failedPages > 0 ? 207 : 200 });
  } catch (error: unknown) {
    logAutoTranslateInfo("Admin all-pages translation request failed", {
      language: requestLanguage ? formatAutoTranslateLanguageForLog(requestLanguage) : undefined,
      error: getAutoTranslateErrorMessage(error),
    });
    return errorResponse(error);
  }
};
