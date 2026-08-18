import { jwtVerify, SignJWT } from "jose";
import { NextResponse, type NextRequest } from "next/server";

import { getRuntimeSecret } from "@/lib/runtime-secrets.mjs";
import { createAdminCredentialFingerprint, isAdminSessionEpoch, SESSION_TOKEN_AUDIENCE, SESSION_TOKEN_ISSUER, SESSION_TOKEN_SCHEMA_VERSION } from "@/lib/session-security";

const encoder = new TextEncoder();
const MODERATOR_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export const ADMIN_COOKIE_NAME = "vicky_admin_session";
export const ADMIN_USERNAME = "admin";

export type AuthRole = "admin" | "moderator";

export type AuthSession = {
  role: AuthRole;
  username: string;
  adminSessionEpoch?: string;
};

const defaultSessionSeconds = Number(process.env.ADMIN_SESSION_MAX_AGE_SECONDS ?? "43200");
export const ADMIN_SESSION_MAX_AGE_SECONDS =
  Number.isFinite(defaultSessionSeconds) && defaultSessionSeconds > 0 ? defaultSessionSeconds : 43200;

const getJwtSecret = (): Uint8Array => encoder.encode(getRuntimeSecret("AUTH_JWT_SECRET"));

export const normalizeUsername = (value: string): string => value.trim().toLowerCase();

export const createSessionToken = async (session: AuthSession): Promise<string> => {
  const secret = getJwtSecret();
  const username = normalizeUsername(session.username);
  const isValidAdmin = session.role === "admin" && username === ADMIN_USERNAME && isAdminSessionEpoch(session.adminSessionEpoch);
  const isValidModerator = session.role === "moderator" && username !== ADMIN_USERNAME && MODERATOR_USERNAME_PATTERN.test(username);
  if (!isValidAdmin && !isValidModerator) {
    throw new TypeError("Cannot create a token for an invalid session.");
  }

  const adminCredentialFingerprint = session.role === "admin" ? await createAdminCredentialFingerprint() : undefined;

  return new SignJWT({
    role: session.role,
    username,
    tokenVersion: SESSION_TOKEN_SCHEMA_VERSION,
    ...(session.role === "admin"
      ? {
          adminSessionEpoch: session.adminSessionEpoch,
          adminCredentialFingerprint,
        }
      : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_TOKEN_ISSUER)
    .setAudience(SESSION_TOKEN_AUDIENCE)
    .setSubject(username)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret);
};

export const verifySessionToken = async (token: string): Promise<AuthSession | null> => {
  try {
    const secret = getJwtSecret();
    const { payload, protectedHeader } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      audience: SESSION_TOKEN_AUDIENCE,
      issuer: SESSION_TOKEN_ISSUER,
      maxTokenAge: ADMIN_SESSION_MAX_AGE_SECONDS,
      requiredClaims: ["aud", "exp", "iat", "iss", "jti", "role", "sub", "tokenVersion", "username"],
      typ: "JWT",
    });
    if (protectedHeader.typ !== "JWT" || payload.aud !== SESSION_TOKEN_AUDIENCE || typeof payload.jti !== "string" || !payload.jti || payload.tokenVersion !== SESSION_TOKEN_SCHEMA_VERSION) {
      return null;
    }

    const role = payload.role === "admin" || payload.role === "moderator" ? payload.role : null;
    if (!role) {
      return null;
    }

    const rawUsername = typeof payload.username === "string" ? payload.username : "";
    const username = normalizeUsername(rawUsername);
    if (!username || username !== rawUsername || payload.sub !== username) {
      return null;
    }

    if (role === "admin") {
      if (username !== ADMIN_USERNAME || !isAdminSessionEpoch(payload.adminSessionEpoch)) {
        return null;
      }

      const credentialFingerprint = await createAdminCredentialFingerprint();
      if (payload.adminCredentialFingerprint !== credentialFingerprint) {
        return null;
      }

      return {
        role,
        username,
        adminSessionEpoch: payload.adminSessionEpoch,
      };
    }

    if (username === ADMIN_USERNAME || !MODERATOR_USERNAME_PATTERN.test(username) || payload.adminSessionEpoch !== undefined || payload.adminCredentialFingerprint !== undefined) {
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
