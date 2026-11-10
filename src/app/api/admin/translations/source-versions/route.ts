import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
import { normalizeAutoTranslateLanguages } from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { resolveRuntimeConfig } from "@/lib/github";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { startSourceVersionRecordingJob } from "@/lib/page-localization-jobs";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The number of files the admin confirmed is required: the job commits to the repository and
// refuses to change more files than that.
const recordSourceVersionsSchema = z
  .object({
    expectedFiles: z.number().int().positive().max(1_000_000),
  })
  .strict();

/** Starts recording the source version in existing translations, with the saved localization settings. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const payload = recordSourceVersionsSchema.parse(await parseJsonBody<unknown>(request));
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);

    const job = startSourceVersionRecordingJob({
      config: resolveRuntimeConfig(store.settings.github),
      languages: normalizeAutoTranslateLanguages(store.settings.autoTranslate.languages),
      localizationPath: store.settings.autoTranslate.localizationPath,
      maxFiles: payload.expectedFiles,
    });

    return NextResponse.json({ job }, { status: 202 });
  } catch (error: unknown) {
    return errorResponse(error, { exposeDetails: true });
  }
};
