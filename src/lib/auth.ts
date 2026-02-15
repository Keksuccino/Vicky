import { jwtVerify, SignJWT } from "jose";
import { NextResponse, type NextRequest } from "next/server";

const encoder = new TextEncoder();

export const ADMIN_COOKIE_NAME = "vicky_admin_session";

const defaultSessionSeconds = Number(process.env.ADMIN_SESSION_MAX_AGE_SECONDS ?? "43200");
export const ADMIN_SESSION_MAX_AGE_SECONDS =
  Number.isFinite(defaultSessionSeconds) && defaultSessionSeconds > 0 ? defaultSessionSeconds : 43200;

const DEV_FALLBACK_AUTH_SECRET = "change-this-dev-auth-secret";
const DEV_FALLBACK_ADMIN_PASSWORD = "admin";

const getJwtSecret = (): Uint8Array => {
  const secret = process.env.AUTH_JWT_SECRET;

  if (!secret?.trim()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Missing AUTH_JWT_SECRET environment variable.");
    }

    return encoder.encode(DEV_FALLBACK_AUTH_SECRET);
  }

  return encoder.encode(secret.trim());
};

const getAdminPassword = (): string => {
  const password = process.env.ADMIN_PASSWORD;

  if (!password?.trim()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Missing ADMIN_PASSWORD environment variable.");
    }

    return DEV_FALLBACK_ADMIN_PASSWORD;
  }

  return password.trim();
};

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  const maxLength = Math.max(left.length, right.length);

  if (maxLength === 0) {
    return true;
  }

  let mismatch = left.length === right.length ? 0 : 1;

  for (let i = 0; i < maxLength; i += 1) {
    const leftByte = i < left.length ? left[i] : 0;
    const rightByte = i < right.length ? right[i] : 0;
    mismatch |= leftByte ^ rightByte;
  }

  return mismatch === 0;
};

const sha256 = async (value: string): Promise<Uint8Array> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return new Uint8Array(digest);
};

export const verifyAdminPassword = async (candidate: string): Promise<boolean> => {
  const expectedPassword = getAdminPassword();
  const [candidateHash, expectedHash] = await Promise.all([sha256(candidate), sha256(expectedPassword)]);

  return constantTimeEqual(candidateHash, expectedHash);
};

export const createAdminSessionToken = async (): Promise<string> => {
  const secret = getJwtSecret();

  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret);
};

export const verifyAdminSessionToken = async (token: string): Promise<boolean> => {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret);
    return payload.role === "admin";
  } catch {
    return false;
  }
};

export const applyAdminSessionCookie = (response: NextResponse, token: string): void => {
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

export const clearAdminSessionCookie = (response: NextResponse): void => {
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

export const isAdminRequest = async (request: NextRequest): Promise<boolean> => {
  const token = request.cookies.get(ADMIN_COOKIE_NAME)?.value;

  if (!token) {
    return false;
  }

  return verifyAdminSessionToken(token);
};

export const requireAdminRequest = async (request: NextRequest): Promise<NextResponse | null> => {
  const authorized = await isAdminRequest(request);

  if (authorized) {
    return null;
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
};
