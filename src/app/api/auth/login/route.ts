import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { applyAdminSessionCookie, createAdminSessionToken, verifyAdminPassword } from "@/lib/auth";
import { errorResponse, parseJsonBody } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  password: z.string().min(1, "Password is required."),
});

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const body = await parseJsonBody<unknown>(request);
    const parsed = loginSchema.parse(body);

    const isValid = await verifyAdminPassword(parsed.password);
    if (!isValid) {
      return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
    }

    const token = await createAdminSessionToken();
    const response = NextResponse.json({ authenticated: true });
    applyAdminSessionCookie(response, token);

    return response;
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
