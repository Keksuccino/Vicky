import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import {
  normalizeAutoTranslateLanguages,
} from "@/lib/auto-translate";
import { requireAdminRequest } from "@/lib/auth";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { listMarkdownDocsTreePagesWithTitles, resolveRuntimeConfig } from "@/lib/github";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { getLatestPageLocalizationJob } from "@/lib/page-localization-jobs";
import { getPageLocalizationStatuses } from "@/lib/page-localization";
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
    localizationPath: z.string().optional(),
  })
  .strict();

type LanguageTranslationCacheStatus = {
  languageCode: string;
  languageName: string;
  cachedPages: number;
  currentPages: number;
  missingPages: number;
  outdatedPages: number;
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
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const { pages } = await listMarkdownDocsTreePagesWithTitles(config);
    const statusResults = await getPageLocalizationStatuses({
      config,
      languages,
      localizationPath: payload.localizationPath ?? store.settings.autoTranslate.localizationPath,
      sourcePages: pages,
    });
    const statuses: LanguageTranslationCacheStatus[] = statusResults.map((status) => ({
      languageCode: status.languageCode,
      languageName: status.languageName,
      cachedPages: status.currentPages,
      currentPages: status.currentPages,
      missingPages: status.missingPages,
      outdatedPages: status.outdatedPages,
      totalPages: status.totalPages,
      sourceLanguage: status.sourceLanguage,
    }));

    return NextResponse.json({
      statuses,
      job: getLatestPageLocalizationJob(),
      updatedAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    return errorResponse(error, { exposeDetails: true });
  }
};
