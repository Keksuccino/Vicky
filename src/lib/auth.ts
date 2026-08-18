import { jwtVerify, SignJWT } from "jose";
import { NextResponse, type NextRequest } from "next/server";

import { getRuntimeSecret } from "@/lib/runtime-secrets.mjs";

const encoder = new TextEncoder();

export const ADMIN_COOKIE_NAME = "vicky_admin_session";
export const ADMIN_USERNAME = "admin";

export type AuthRole = "admin" | "moderator";

export type AuthSession = {
  role: AuthRole;
  username: string;
};

const defaultSessionSeconds = Number(process.env.ADMIN_SESSION_MAX_AGE_SECONDS ?? "43200");
export const ADMIN_SESSION_MAX_AGE_SECONDS =
  Number.isFinite(defaultSessionSeconds) && defaultSessionSeconds > 0 ? defaultSessionSeconds : 43200;

const getJwtSecret = (): Uint8Array => encoder.encode(getRuntimeSecret("AUTH_JWT_SECRET"));

export const normalizeUsername = (value: string): string => value.trim().toLowerCase();

export const createSessionToken = async (session: AuthSession): Promise<string> => {
  const secret = getJwtSecret();

  return new SignJWT({
    role: session.role,
    username: normalizeUsername(session.username),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret);
};

export const createAdminSessionToken = async (): Promise<string> =>
  createSessionToken({ role: "admin", username: ADMIN_USERNAME });

export const verifySessionToken = async (token: string): Promise<AuthSession | null> => {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret);
    const role = payload.role === "admin" || payload.role === "moderator" ? payload.role : null;
    if (!role) {
      return null;
    }

    const rawUsername = typeof payload.username === "string" ? payload.username : "";
    const username = normalizeUsername(rawUsername || (role === "admin" ? ADMIN_USERNAME : ""));
    if (!username) {
      return null;
    }

    return {
      role,
      username,
    };
  } catch {
    return null;
  }
};

export const verifyAdminSessionToken = async (token: string): Promise<boolean> => {
  const session = await verifySessionToken(token);
  return session?.role === "admin";
};

export const applySessionCookie = (response: NextResponse, token: string): void => {
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
};

export const applyAdminSessionCookie = applySessionCookie;

export const clearSessionCookie = (response: NextResponse): void => {
  response.cookies.set({
    name: ADMIN_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
};

export const clearAdminSessionCookie = clearSessionCookie;

export const getRequestSession = async (request: NextRequest): Promise<AuthSession | null> => {
  const token = request.cookies.get(ADMIN_COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  return verifySessionToken(token);
};

export const isAdminRequest = async (request: NextRequest): Promise<boolean> => {
  const session = await getRequestSession(request);
  return session?.role === "admin";
};

export const requireAdminRequest = async (request: NextRequest): Promise<NextResponse | null> => {
  const authorized = await isAdminRequest(request);

  if (authorized) {
    return null;
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
};
