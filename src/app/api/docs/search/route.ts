import Fuse from "fuse.js";
import { NextResponse, type NextRequest } from "next/server";

import { listMarkdownDocsTree, resolveRuntimeConfig } from "@/lib/github";
import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";

    const store = await getStore();
    const config = resolveRuntimeConfig(store.settings.github);
    const items = await listMarkdownDocsTree(config);

    if (!query) {
      return NextResponse.json({
        query,
        results: items.slice(0, 50),
      });
    }

    const fuse = new Fuse(items, {
      includeScore: true,
      threshold: 0.35,
      keys: [
        { name: "name", weight: 0.5 },
        { name: "slug", weight: 0.3 },
        { name: "path", weight: 0.2 },
      ],
    });

    const results = fuse.search(query, { limit: 50 }).map((entry) => ({
      ...entry.item,
      score: entry.score ?? 0,
    }));

    return NextResponse.json({
      query,
      results,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
