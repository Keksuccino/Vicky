import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { createPerformanceStatsSnapshot } from "@/lib/performance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const performance = await createPerformanceStatsSnapshot();

    return NextResponse.json(
      { performance },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
