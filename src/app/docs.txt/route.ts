import { type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { getPlaintextDocsExport } from "@/lib/docs-plaintext";
import { resolveRuntimeConfig } from "@/lib/github";
import { badRequest, publicTextErrorResponse } from "@/lib/http";
import { resolveRequestOrigin } from "@/lib/request-origin-policy.mjs";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT_PLAIN_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, must-revalidate",
};

export const GET = async (request: NextRequest): Promise<Response> => {
  try {
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const origin = resolveRequestOrigin({ customDomain: store.settings.domain?.customDomain, headers: request.headers });
    if (!origin) {
      throw badRequest("Invalid request authority.");
    }
    const body = await getPlaintextDocsExport(config, origin);

    return new Response(body, {
      status: 200,
      headers: TEXT_PLAIN_HEADERS,
    });
  } catch (error: unknown) {
    return publicTextErrorResponse(error, { context: "GET /docs.txt", headers: TEXT_PLAIN_HEADERS });
  }
};
