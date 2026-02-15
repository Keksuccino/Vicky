import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { updateStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const payloadSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await parseJsonBody<unknown>(request);
    const payload = payloadSchema.parse(body);

    const updatedStore = await updateStore((store) => {
      const exists = store.themes.some((theme) => theme.id === payload.id);
      if (!exists) {
        throw badRequest("Theme does not exist.");
      }

      store.settings.activeThemeId = payload.id;
    });

    return NextResponse.json({
      activeThemeId: updatedStore.settings.activeThemeId,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
