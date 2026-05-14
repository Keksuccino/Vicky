import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, parseJsonBody } from "@/lib/http";
import { enqueueDocPageVisit } from "@/lib/visitors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const visitSchema = z
  .object({
    path: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().optional().default(""),
  })
  .strict();

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const payload = visitSchema.parse(await parseJsonBody<unknown>(request));
    const queued = enqueueDocPageVisit(request, payload);

    return NextResponse.json({ queued }, { status: 202 });
  } catch (error: unknown) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return errorResponse(error);
    }

    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[visitors] Failed to queue docs page visit: ${message}`);
    return NextResponse.json({ queued: false }, { status: 202 });
  }
};
