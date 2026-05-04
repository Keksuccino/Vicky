import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { applySessionCookie, createSessionToken } from "@/lib/auth";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { clearFailedLoginAttempts, getLoginRateLimitStatus, registerFailedLoginAttempt } from "@/lib/login-rate-limit";
import { authenticateCredentials } from "@/lib/moderators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required."),
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
    const initialRateLimit = await getLoginRateLimitStatus(request);
    if (initialRateLimit.blocked) {
      return blockedLoginResponse(initialRateLimit.retryAfterSeconds);
    }

    const body = await parseJsonBody<unknown>(request);
    const parsed = loginSchema.parse(body);

    const session = await authenticateCredentials(parsed.username, parsed.password);
    if (!session) {
      const nextRateLimit = await registerFailedLoginAttempt(request);
      if (nextRateLimit.blocked) {
        return blockedLoginResponse(nextRateLimit.retryAfterSeconds);
      }

      return NextResponse.json(
        {
          error: "Invalid credentials.",
          attemptsLeft: nextRateLimit.attemptsLeft,
        },
        { status: 401 },
      );
    }

    await clearFailedLoginAttempts(request);
    const token = await createSessionToken(session);
    const response = NextResponse.json({ authenticated: true, role: session.role, username: session.username });
    applySessionCookie(response, token);

    return response;
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
