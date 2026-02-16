import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { applyAdminSessionCookie, createAdminSessionToken, verifyAdminPassword } from "@/lib/auth";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { clearFailedLoginAttempts, getLoginRateLimitStatus, registerFailedLoginAttempt } from "@/lib/login-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  password: z.string().min(1, "Password is required."),
});

const blockedLoginResponse = (retryAfterSeconds: number): NextResponse =>
  NextResponse.json(
    {
      error: "Too many failed login attempts. Please try again later.",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const initialRateLimit = getLoginRateLimitStatus(request);
    if (initialRateLimit.blocked) {
      return blockedLoginResponse(initialRateLimit.retryAfterSeconds);
    }

    const body = await parseJsonBody<unknown>(request);
    const parsed = loginSchema.parse(body);

    const isValid = await verifyAdminPassword(parsed.password);
    if (!isValid) {
      const nextRateLimit = registerFailedLoginAttempt(request);
      if (nextRateLimit.blocked) {
        return blockedLoginResponse(nextRateLimit.retryAfterSeconds);
      }

      return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
    }

    clearFailedLoginAttempts(request);
    const token = await createAdminSessionToken();
    const response = NextResponse.json({ authenticated: true });
    applyAdminSessionCookie(response, token);

    return response;
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
