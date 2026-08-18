import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
import { revokeAdminSessions } from "@/lib/admin-session-security";
import { clearSessionCookie } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    await revokeAdminSessions();
    const response = NextResponse.json({ revoked: true });
    clearSessionCookie(response);
    return response;
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
