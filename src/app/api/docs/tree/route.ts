import { NextResponse } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { listMarkdownDocsTree, resolveRuntimeConfig } from "@/lib/github";
import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (): Promise<NextResponse> => {
  try {
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const items = await listMarkdownDocsTree(config);

    return NextResponse.json({ items });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
