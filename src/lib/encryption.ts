import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { getRuntimeSecret } from "@/lib/runtime-secrets.mjs";

const ENCRYPTION_PREFIX = "enc:v1";

const getKey = (): Buffer => createHash("sha256").update(getRuntimeSecret("ENCRYPTION_SECRET"), "utf8").digest();

export const encryptSecret = (plainText: string): string => {
  if (!plainText) {
    return "";
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
};

export const decryptSecret = (payload: string | null | undefined): string => {
  if (!payload) {
    return "";
  }

  if (!payload.startsWith(`${ENCRYPTION_PREFIX}:`)) {
    throw new Error("Encrypted payload format is invalid.");
  }

  const encodedParts = payload.slice(ENCRYPTION_PREFIX.length + 1).split(":");
  const [ivB64, authTagB64, encryptedB64] = encodedParts;

  if (encodedParts.length !== 3 || !ivB64 || !authTagB64 || !encryptedB64) {
    throw new Error("Encrypted payload format is invalid.");
  }

  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64url")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
};
