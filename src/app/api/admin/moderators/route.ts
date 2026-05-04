import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { createModeratorAccount, listModeratorAccounts } from "@/lib/moderators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createModeratorSchema = z
  .object({
    username: z.string().min(1, "Username is required."),
    password: z.string().min(1, "Password is required."),
  })
  .strict();

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const moderators = await listModeratorAccounts();
    return NextResponse.json({ moderators });
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
    const payload = createModeratorSchema.parse(body);
    const moderator = await createModeratorAccount(payload);

    return NextResponse.json({ moderator }, { status: 201 });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
