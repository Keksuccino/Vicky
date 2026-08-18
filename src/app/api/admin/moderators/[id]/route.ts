import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { deleteModeratorAccount, updateModeratorAccount } from "@/lib/moderators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id?: string;
  }>;
};

const updateModeratorSchema = z
  .object({
    username: z.string().min(1, "Username is required.").optional(),
    password: z.string().min(1, "Password is required.").optional(),
  })
  .strict();

const getModeratorId = async (context: RouteContext): Promise<string> => {
  const params = await context.params;
  const id = params.id?.trim();
  if (!id) {
    throw badRequest("Moderator id is required.");
  }

  return id;
};

export const PATCH = async (request: NextRequest, context: RouteContext): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const id = await getModeratorId(context);
    const body = await parseJsonBody<unknown>(request);
    const payload = updateModeratorSchema.parse(body);
    const moderator = await updateModeratorAccount(id, payload);

    return NextResponse.json({ moderator });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};

export const DELETE = async (request: NextRequest, context: RouteContext): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const id = await getModeratorId(context);
    await deleteModeratorAccount(id);

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
