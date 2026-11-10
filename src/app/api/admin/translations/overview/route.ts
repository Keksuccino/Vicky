import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
import { normalizeAutoTranslateLanguages } from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { resolveRuntimeConfig } from "@/lib/github";
import { errorResponse } from "@/lib/http";
import { loadPageLocalizationOverview } from "@/lib/page-localization-read";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Status of every saved language for the Page Localization card, without a job: computed from the
 * repository index and stored blob summaries, never waiting for GitHub. A language whose files
 * are still being fetched for the first time reports the progress of that background download.
 */
export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const { localizationPath } = store.settings.autoTranslate;
    const statuses = await loadPageLocalizationOverview({
      config: resolveRuntimeConfig(store.settings.github),
      languages: normalizeAutoTranslateLanguages(store.settings.autoTranslate.languages),
      localizationPath,
    });

    return NextResponse.json({ statuses, localizationPath, updatedAt: new Date().toISOString() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    return errorResponse(error, { exposeDetails: true });
  }
};
