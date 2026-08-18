import { NextResponse, type NextRequest } from "next/server";

import { setDocsCacheTtlMs } from "@/lib/cache";
import { listMarkdownDocsTree, resolveRuntimeConfig } from "@/lib/github";
import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";
import { assertVisitorIngestionSameSite, parseVisitorIngestionRequest, resolveKnownVisitorPageIdentity } from "@/lib/visitor-ingestion";
import { acquireVisitorIngestionPermit } from "@/lib/visitor-ingestion-rate-limit";
import { enqueueDocPageVisit } from "@/lib/visitors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const rateLimitResponse = (retryAfterSeconds: number, message: string): NextResponse => NextResponse.json({ error: message, retryAfterSeconds }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    assertVisitorIngestionSameSite(request);
  } catch (error: unknown) {
    return errorResponse(error);
  }

  const permit = acquireVisitorIngestionPermit(request);
  if (!permit.allowed) {
    return rateLimitResponse(permit.retryAfterSeconds, "Too many analytics requests. Please try again later.");
  }

  try {
    const payload = await parseVisitorIngestionRequest(request);
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const tree = await listMarkdownDocsTree(config);
    const page = resolveKnownVisitorPageIdentity(payload, tree, config);
    const enqueueResult = enqueueDocPageVisit(request, page, payload.eventId);

    if (enqueueResult.status === "full") {
      return rateLimitResponse(enqueueResult.retryAfterSeconds, "Analytics queue is full. Please try again later.");
    }

    return NextResponse.json({ duplicate: enqueueResult.status === "duplicate", queued: enqueueResult.status === "queued" }, { status: 202 });
  } catch (error: unknown) {
    return errorResponse(error);
  } finally {
    permit.release();
  }
};
