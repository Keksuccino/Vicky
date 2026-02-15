import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { resolveRuntimeConfig, testGitHubConnection } from "@/lib/github";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const payloadSchema = z
  .object({
    owner: z.string().optional(),
    repo: z.string().optional(),
    branch: z.string().optional(),
    docsPath: z.string().optional(),
    token: z.string().optional(),
  })
  .strict();

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const store = await getStore();
    const body = await parseJsonBody<unknown>(request);
    const payload = payloadSchema.parse(body);

    const runtimeConfig = resolveRuntimeConfig(
      {
        ...store.settings.github,
        owner: payload.owner?.trim() ?? store.settings.github.owner,
        repo: payload.repo?.trim() ?? store.settings.github.repo,
        branch: payload.branch?.trim() ?? store.settings.github.branch,
        docsPath: payload.docsPath?.trim() ?? store.settings.github.docsPath,
      },
      payload.token,
    );

    const result = await testGitHubConnection(runtimeConfig);

    return NextResponse.json(result);
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
