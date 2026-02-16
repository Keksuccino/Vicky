import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadGitHubDoc, resolveRuntimeConfig, saveGitHubDoc } from "@/lib/github";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const saveSchema = z
  .object({
    slug: z.string().optional(),
    path: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    content: z.string().optional(),
    markdown: z.string().optional(),
    commitMessage: z.string().optional(),
  })
  .strict();

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const slug = request.nextUrl.searchParams.get("slug") ?? undefined;
    const path = request.nextUrl.searchParams.get("path") ?? undefined;

    if (!slug && !path) {
      throw badRequest("A slug or path query parameter is required.");
    }

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const page = await loadGitHubDoc(config, { slug, path });

    return NextResponse.json({ page });
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

    const body = await parseJsonBody<unknown>(request);
    const payload = saveSchema.parse(body);

    if (!payload.path && !payload.slug) {
      throw badRequest("Either slug or path must be provided.");
    }

    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);

    const saved = await saveGitHubDoc(config, payload);
    const page = await loadGitHubDoc(config, {
      path: saved.path,
    });

    return NextResponse.json({
      saved,
      page,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
