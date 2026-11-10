import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
import { errorResponse } from "@/lib/http";
import { loadMarkdownRenderCacheContext } from "@/lib/markdown-render-cache-admin";
import { getMarkdownRenderCacheWarmJob, startMarkdownRenderCacheWarmJob } from "@/lib/markdown-render-cache-warm-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** The latest warm job from process memory; the admin card polls it while the job runs. */
export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    return NextResponse.json({ job: getMarkdownRenderCacheWarmJob() }, { headers: NO_STORE });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};

/** Starts rendering the missing HTML in the background (or returns the job already running). */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const job = startMarkdownRenderCacheWarmJob(await loadMarkdownRenderCacheContext());
    return NextResponse.json({ job }, { status: 202, headers: NO_STORE });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
