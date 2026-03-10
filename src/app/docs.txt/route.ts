import { type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { getPlaintextDocsExport } from "@/lib/docs-plaintext";
import { resolveRuntimeConfig } from "@/lib/github";
import { ApiError } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEXT_PLAIN_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, must-revalidate",
};

const resolveRequestOrigin = (request: NextRequest): string => {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
};

export const GET = async (request: NextRequest): Promise<Response> => {
  try {
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const origin = resolveRequestOrigin(request);
    const body = await getPlaintextDocsExport(config, origin);

    return new Response(body, {
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
