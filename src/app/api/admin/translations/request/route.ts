import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import {
  normalizeAutoTranslateLanguage,
  normalizeAutoTranslateLanguages,
} from "@/lib/auto-translate";
import {
  formatAutoTranslateLanguageForLog,
  getAutoTranslateErrorMessage,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import { requireAdminRequest } from "@/lib/auth";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { isCircleFlagIconId } from "@/lib/circle-flags";
import { decryptSecret } from "@/lib/encryption";
import { listMarkdownDocsTreePagesWithTitles, resolveRuntimeConfig } from "@/lib/github";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import {
  normalizeRequestedLocalizationLanguageCodes,
  translatePageLocalizations,
  type PageLocalizationRequestMode,
} from "@/lib/page-localization";
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
      .optional(),
    languageCodes: z.array(z.string()).optional(),
    mode: z.enum(["outdated", "missing-and-outdated"]).optional(),
    localizationPath: z.string().optional(),
    languages: z.array(
      z
        .object({
          name: z.string(),
          code: z.string(),
          icon: z
            .string()
            .refine(isCircleFlagIconId, "Language icon must be a Circle Flags icon ID."),
        })
      .strict(),
    ).optional(),
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
    const store = await getStore();
    const configuredLanguages = normalizeAutoTranslateLanguages(payload.languages ?? store.settings.autoTranslate.languages);
    const singleLanguage = payload.language ? normalizeAutoTranslateLanguage(payload.language) : null;
    const languages = singleLanguage
      ? [singleLanguage]
      : normalizeRequestedLocalizationLanguageCodes(payload.languageCodes, configuredLanguages);
    const mode: PageLocalizationRequestMode = payload.mode ?? "missing-and-outdated";
    requestLanguage = singleLanguage ?? languages[0] ?? null;

    if (languages.length === 0) {
      throw badRequest("At least one target localization language is required.");
    }

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
    logAutoTranslateInfo("Admin requested page localization translations", {
      language: languages.map((language) => formatAutoTranslateLanguageForLog(language)).join(", "),
      totalPages: pages.length,
      model,
    });

    const result = await translatePageLocalizations({
      apiKey,
      config,
      languages,
      localizationPath: payload.localizationPath ?? store.settings.autoTranslate.localizationPath,
      mode,
      model,
      origin: resolveRequestOrigin(request),
      sourcePages: pages,
      siteTitle: store.settings.siteTitle || "Vicky Docs",
    });

    logAutoTranslateInfo("Admin page localization request finished", {
      language: languages.map((language) => formatAutoTranslateLanguageForLog(language)).join(", "),
      totalPages: result.totalPages,
      cachedPages: result.cachedPages,
      requestedPages: result.requestedPages,
      translatedPages: result.translatedPages,
      failedPages: result.failedPages,
      model,
    });

    return NextResponse.json({ result }, { status: result.failedPages > 0 ? 207 : 200 });
  } catch (error: unknown) {
    logAutoTranslateInfo("Admin page localization request failed", {
      language: requestLanguage ? formatAutoTranslateLanguageForLog(requestLanguage) : undefined,
      error: getAutoTranslateErrorMessage(error),
    });
    return errorResponse(error);
  }
};
