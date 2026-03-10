import { type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadGitHubDoc, resolveRuntimeConfig } from "@/lib/github";
import { ApiError } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT_PLAIN_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, must-revalidate",
};

type RawDocRouteContext = {
  params: Promise<{ slug: string[] }>;
};

export const GET = async (_request: NextRequest, { params }: RawDocRouteContext): Promise<Response> => {
  try {
    const resolved = await params;
    const slug = resolved.slug.join("/");

    if (!slug) {
      return new Response("Document not found.", {
        status: 404,
        headers: TEXT_PLAIN_HEADERS,
      });
    }

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const page = await loadGitHubDoc(config, { slug });

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
