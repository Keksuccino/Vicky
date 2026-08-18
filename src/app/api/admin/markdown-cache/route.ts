import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { resolveRuntimeConfig } from "@/lib/github";
import { errorResponse } from "@/lib/http";
import {
  clearMarkdownRenderCache,
  createMarkdownRenderCacheStatus,
  warmMarkdownRenderCache,
} from "@/lib/markdown-render-cache-admin";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loadMarkdownCacheContext = async () => {
  const store = await getStore();
  setDocsCacheTtlMs(store.settings.docsCacheTtlMs);

  return {
    config: resolveRuntimeConfig(store.settings.github),
    store,
  };
};

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { config, store } = await loadMarkdownCacheContext();
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

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { config, store } = await loadMarkdownCacheContext();
    const result = await warmMarkdownRenderCache({ config, store });
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

export const DELETE = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const slug = request.nextUrl.searchParams.get("slug") ?? undefined;
    const { config, store } = await loadMarkdownCacheContext();
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
