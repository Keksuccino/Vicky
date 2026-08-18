import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { getPageLocalizationJobStatus } from "@/lib/page-localization-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Unknown keys are intentionally stripped so a browser running the previous client bundle can
// still send its old language fields without re-enabling repository-backed status computation.
const translationStatusSchema = z.object({
  jobId: z.string().trim().min(1).max(256).optional(),
});

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await parseJsonBody<unknown>(request);
    const payload = translationStatusSchema.parse(body);
    const lookup = getPageLocalizationJobStatus(payload.jobId);
    const statuses = lookup.job?.statuses.map((status) => ({ ...status, cachedPages: status.currentPages })) ?? [];

    return NextResponse.json({ statuses, job: lookup.job, jobState: lookup.state, updatedAt: new Date().toISOString() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error: unknown) {
    return errorResponse(error, { exposeDetails: true });
  }
};
