import { type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadGitHubDoc, resolveRuntimeConfig } from "@/lib/github";
import { badRequest, ApiError } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT_PLAIN_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, must-revalidate",
};

export const GET = async (request: NextRequest): Promise<Response> => {
  try {
    const slug = request.nextUrl.searchParams.get("slug") ?? undefined;
    const path = request.nextUrl.searchParams.get("path") ?? undefined;

    if (!slug && !path) {
      throw badRequest("A slug or path query parameter is required.");
    }

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const page = await loadGitHubDoc(config, { slug, path });

    return new Response(page.markdown, {
      status: 200,
      headers: TEXT_PLAIN_HEADERS,
    });
  } catch (error: unknown) {
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Internal Server Error";

    return new Response(message, {
      status,
      headers: TEXT_PLAIN_HEADERS,
    });
  }
};
