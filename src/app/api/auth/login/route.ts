import { NextResponse, type NextRequest } from "next/server";

import { getAdminSessionSecurityState } from "@/lib/admin-session-security";
import { applySessionCookie, createSessionToken } from "@/lib/auth";
import { ADMIN_PASSWORD_BUSY_RETRY_AFTER_SECONDS, AdminPasswordVerificationBusyError } from "@/lib/admin-password";
import { errorResponse } from "@/lib/http";
import { parseLoginRequest } from "@/lib/login-input";
import { clearFailedLoginAttempts, getLoginRateLimitStatus, registerFailedLoginAttempt } from "@/lib/login-rate-limit";
import { authenticateCredentials } from "@/lib/moderators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

const passwordVerificationBusyResponse = (): NextResponse => NextResponse.json({ error: "Authentication is temporarily busy. Please try again shortly.", retryAfterSeconds: ADMIN_PASSWORD_BUSY_RETRY_AFTER_SECONDS }, { status: 503, headers: { "Retry-After": String(ADMIN_PASSWORD_BUSY_RETRY_AFTER_SECONDS) } });

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const initialRateLimit = await getLoginRateLimitStatus(request);
    if (initialRateLimit.blocked) {
      return blockedLoginResponse(initialRateLimit.retryAfterSeconds);
    }

    const parsed = await parseLoginRequest(request);

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
    const tokenSession = session.role === "admin" ? { ...session, adminSessionEpoch: (await getAdminSessionSecurityState()).sessionEpoch } : session;
    const token = await createSessionToken(tokenSession);
    const response = NextResponse.json({ authenticated: true, role: session.role, username: session.username });
    applySessionCookie(response, token);

    return response;
  } catch (error: unknown) {
    if (error instanceof AdminPasswordVerificationBusyError) {
      return passwordVerificationBusyResponse();
    }

    return errorResponse(error);
  }
};
