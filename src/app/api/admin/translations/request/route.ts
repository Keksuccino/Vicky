import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import {
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguage,
} from "@/lib/auto-translate";
import { translateMissingGitHubDocPages } from "@/lib/auto-translate-server";
import { requireAdminRequest } from "@/lib/auth";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { decryptSecret } from "@/lib/encryption";
import { listMarkdownDocsTreePagesWithTitles, resolveRuntimeConfig } from "@/lib/github";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestTranslationsSchema = z
  .object({
    language: z
      .object({
        name: z.string().min(1, "Language name is required."),
        code: z.string().min(1, "Language code is required."),
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
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await parseJsonBody<unknown>(request);
    const payload = requestTranslationsSchema.parse(body);
    const language = normalizeAutoTranslateLanguage(payload.language);

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

    return NextResponse.json({ result }, { status: result.failedPages > 0 ? 207 : 200 });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
