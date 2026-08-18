import { getRuntimeSecret } from "@/lib/runtime-secrets.mjs";

const encoder = new TextEncoder();

export const SESSION_TOKEN_AUDIENCE = "vicky-control-panel";
export const SESSION_TOKEN_ISSUER = "vicky";
export const SESSION_TOKEN_SCHEMA_VERSION = 1;

const ADMIN_CREDENTIAL_BINDING_CONTEXT = "vicky:admin-credential-binding:v1";
const ADMIN_CREDENTIAL_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const ADMIN_SESSION_EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const encodeBoundValue = (name: string, value: string): string => `${name}:${encoder.encode(value).byteLength}:${value}`;

const bytesToHex = (value: ArrayBuffer): string =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Creates a non-reversible deployment binding without exposing a reusable password
 * verifier in either the JWT payload or the store. AUTH_JWT_SECRET is the HMAC key;
 * length-prefixed ADMIN_PASSWORD and ENCRYPTION_SECRET inputs avoid ambiguous encodings.
 * This module deliberately uses Web Crypto so the same check is safe in Edge middleware.
 */
export const createAdminCredentialFingerprint = async (): Promise<string> => {
  const authSecret = getRuntimeSecret("AUTH_JWT_SECRET");
  const adminPassword = getRuntimeSecret("ADMIN_PASSWORD");
  const encryptionSecret = getRuntimeSecret("ENCRYPTION_SECRET");
  const key = await crypto.subtle.importKey("raw", encoder.encode(authSecret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const message = [
    ADMIN_CREDENTIAL_BINDING_CONTEXT,
    encodeBoundValue("ADMIN_PASSWORD", adminPassword),
    encodeBoundValue("ENCRYPTION_SECRET", encryptionSecret),
  ].join("\n");
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
};

export const isAdminCredentialFingerprint = (value: unknown): value is string =>
  typeof value === "string" && ADMIN_CREDENTIAL_FINGERPRINT_PATTERN.test(value);

export const isAdminSessionEpoch = (value: unknown): value is string =>
  typeof value === "string" && ADMIN_SESSION_EPOCH_PATTERN.test(value);
