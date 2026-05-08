import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import {
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguages,
} from "@/lib/auto-translate";
import { getGitHubDocPageTranslationCacheStatus } from "@/lib/auto-translate-server";
import { requireAdminRequest } from "@/lib/auth";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { listMarkdownDocsTreePagesWithTitles, resolveRuntimeConfig } from "@/lib/github";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { getStore } from "@/lib/store";
import type { AutoTranslateLanguage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const languageSchema = z
  .object({
    name: z.string(),
    code: z.string(),
    icon: z.string(),
  })
  .strict();

const translationStatusSchema = z
  .object({
    languages: z.array(languageSchema).optional(),
    model: z.string().optional(),
  })
  .strict();

type LanguageTranslationCacheStatus = {
  languageCode: string;
  cachedPages: number;
  totalPages: number;
  sourceLanguage: boolean;
};

const uniqueLanguagesByCode = (languages: AutoTranslateLanguage[]): AutoTranslateLanguage[] => {
  const seen = new Set<string>();
  const output: AutoTranslateLanguage[] = [];

  for (const language of languages) {
    const key = language.code.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(language);
  }

  return output;
};

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const store = await getStore();
    const body = await parseJsonBody<unknown>(request);
    const payload = translationStatusSchema.parse(body);
    const languages = uniqueLanguagesByCode(
      normalizeAutoTranslateLanguages(payload.languages ?? store.settings.autoTranslate.languages),
    );
    const model = (payload.model ?? store.settings.autoTranslate.openRouterModel).trim();

    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const { pages } = await listMarkdownDocsTreePagesWithTitles(config, { bypassCache: true });
    const totalPages = pages.length;
    const statuses: LanguageTranslationCacheStatus[] = languages.map((language) => {
      const sourceLanguage = isDefaultAutoTranslateLanguageCode(language.code);
      if (sourceLanguage) {
        return {
          languageCode: language.code,
          cachedPages: totalPages,
          totalPages,
          sourceLanguage,
        };
      }

      const status = getGitHubDocPageTranslationCacheStatus({
        config,
        language,
        model,
        pages,
      });

      return {
        languageCode: language.code,
        cachedPages: status.cachedPages,
        totalPages: status.totalPages,
        sourceLanguage,
      };
    });

    return NextResponse.json({
      statuses,
      updatedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
