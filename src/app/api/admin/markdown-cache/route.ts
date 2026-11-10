import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
import { errorResponse } from "@/lib/http";
import {
  clearMarkdownRenderCache,
  createMarkdownRenderCacheStatus,
  loadMarkdownRenderCacheContext,
} from "@/lib/markdown-render-cache-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { config, store } = await loadMarkdownRenderCacheContext();
    const status = await createMarkdownRenderCacheStatus({ config, store });

    return NextResponse.json(
      { status },
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

export const DELETE = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const slug = request.nextUrl.searchParams.get("slug") ?? undefined;
    const { config, store } = await loadMarkdownRenderCacheContext();
    const result = await clearMarkdownRenderCache({ config, slug });
    const status = await createMarkdownRenderCacheStatus({ config, store });

    return NextResponse.json(
      { result, status },
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
