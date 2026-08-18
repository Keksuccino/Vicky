import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_STORE } from "@/lib/defaults";

const AUTH_SECRET_ONE = "M8vR2kX7pQ4nT9cF6yH1sD5wJ0zB3gLaEeUi";
const AUTH_SECRET_TWO = "T9cF6yH1sD5wJ0zB3gLaEeUiM8vR2kX7pQ4nK";
const ENCRYPTION_SECRET_ONE = "N4wC8kU1rZ6dP9xF3mT7qH2sV5bJ0yLgEeAi";
const ENCRYPTION_SECRET_TWO = "R6dP9xF3mT7qH2sV5bJ0yLgEeAiN4wC8kU1zK";
const ADMIN_PASSWORD_ONE = "Vicky tests: cedar! orbit7 glass";
const ADMIN_PASSWORD_TWO = "Vicky rotated: amber! summit8 quartz";

const originalEnvironment = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  AUTH_JWT_SECRET: process.env.AUTH_JWT_SECRET,
  ENCRYPTION_SECRET: process.env.ENCRYPTION_SECRET,
  WIKI_STORE_FILE_PATH: process.env.WIKI_STORE_FILE_PATH,
};
const tempDirs: string[] = [];

const restoreEnvironmentValue = (name: keyof typeof originalEnvironment): void => {
  const value = originalEnvironment[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

const configureSecrets = (): void => {
  process.env.AUTH_JWT_SECRET = AUTH_SECRET_ONE;
  process.env.ENCRYPTION_SECRET = ENCRYPTION_SECRET_ONE;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD_ONE;
};

const createStorePath = async (): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-auth-session-test-"));
  tempDirs.push(tempDir);
  const storePath = path.join(tempDir, "wiki-store.json");
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(DEFAULT_STORE(), null, 2), "utf8");
  return storePath;
};

const loadSessionModules = async (storePath: string) => {
  vi.resetModules();
  process.env.WIKI_STORE_FILE_PATH = storePath;
  const auth = await import("@/lib/auth");
  const activeAuth = await import("@/lib/active-auth");
  const adminSecurity = await import("@/lib/admin-session-security");
  const store = await import("@/lib/store");
  return { activeAuth, adminSecurity, auth, store };
};

afterEach(async () => {
  restoreEnvironmentValue("ADMIN_PASSWORD");
  restoreEnvironmentValue("AUTH_JWT_SECRET");
  restoreEnvironmentValue("ENCRYPTION_SECRET");
  restoreEnvironmentValue("WIKI_STORE_FILE_PATH");
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("admin session security", () => {
  it("rejects pre-schema tokens and issuer or audience mismatches", async () => {
    configureSecrets();
    vi.resetModules();
    const { verifySessionToken } = await import("@/lib/auth");
    const { SESSION_TOKEN_AUDIENCE, SESSION_TOKEN_ISSUER, SESSION_TOKEN_SCHEMA_VERSION } = await import("@/lib/session-security");
    const key = new TextEncoder().encode(AUTH_SECRET_ONE);
    const legacyToken = await new SignJWT({ role: "admin", username: "admin" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(key);
    const createModeratorToken = (issuer: string, audience: string): Promise<string> => new SignJWT({ role: "moderator", tokenVersion: SESSION_TOKEN_SCHEMA_VERSION, username: "editor" }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(issuer).setAudience(audience).setSubject("editor").setJti("test-token").setIssuedAt().setExpirationTime("1h").sign(key);

    const validToken = await createModeratorToken(SESSION_TOKEN_ISSUER, SESSION_TOKEN_AUDIENCE);
    const wrongIssuerToken = await createModeratorToken("other-issuer", SESSION_TOKEN_AUDIENCE);
    const wrongAudienceToken = await createModeratorToken(SESSION_TOKEN_ISSUER, "other-audience");

    await expect(verifySessionToken(legacyToken)).resolves.toBeNull();
    await expect(verifySessionToken(wrongIssuerToken)).resolves.toBeNull();
    await expect(verifySessionToken(wrongAudienceToken)).resolves.toBeNull();
    await expect(verifySessionToken(validToken)).resolves.toEqual({ role: "moderator", username: "editor" });
  });

  it("rejects an old admin token after an ADMIN_PASSWORD change across restart", async () => {
    configureSecrets();
    const storePath = await createStorePath();
    const first = await loadSessionModules(storePath);
    const firstSecurity = await first.adminSecurity.getAdminSessionSecurityState();
    const oldToken = await first.auth.createSessionToken({ role: "admin", username: "admin", adminSessionEpoch: firstSecurity.sessionEpoch });
    await expect(first.activeAuth.getActiveSessionForToken(oldToken)).resolves.toMatchObject({ role: "admin", username: "admin" });

    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD_TWO;
    const restarted = await loadSessionModules(storePath);
    await expect(restarted.auth.verifySessionToken(oldToken)).resolves.toBeNull();
    const restartedSecurity = await restarted.adminSecurity.getAdminSessionSecurityState();

    expect(restartedSecurity.sessionEpoch).not.toBe(firstSecurity.sessionEpoch);
    expect(restartedSecurity.credentialFingerprint).not.toBe(firstSecurity.credentialFingerprint);
    const persisted = JSON.parse(await readFile(storePath, "utf8")) as ReturnType<typeof DEFAULT_STORE>;
    expect(persisted.adminSessionSecurity).toEqual(restartedSecurity);
  });

  it("invalidates admin tokens and rotates the epoch for encryption and JWT secret changes", async () => {
    configureSecrets();
    const storePath = await createStorePath();
    const modules = await loadSessionModules(storePath);
    const initialSecurity = await modules.adminSecurity.getAdminSessionSecurityState();
    const initialToken = await modules.auth.createSessionToken({ role: "admin", username: "admin", adminSessionEpoch: initialSecurity.sessionEpoch });

    process.env.ENCRYPTION_SECRET = ENCRYPTION_SECRET_TWO;
    await expect(modules.auth.verifySessionToken(initialToken)).resolves.toBeNull();
    const encryptionRotatedSecurity = await modules.adminSecurity.getAdminSessionSecurityState();
    expect(encryptionRotatedSecurity.sessionEpoch).not.toBe(initialSecurity.sessionEpoch);
    const encryptionRotatedToken = await modules.auth.createSessionToken({ role: "admin", username: "admin", adminSessionEpoch: encryptionRotatedSecurity.sessionEpoch });

    process.env.AUTH_JWT_SECRET = AUTH_SECRET_TWO;
    await expect(modules.auth.verifySessionToken(encryptionRotatedToken)).resolves.toBeNull();
    const jwtRotatedSecurity = await modules.adminSecurity.getAdminSessionSecurityState();
    expect(jwtRotatedSecurity.sessionEpoch).not.toBe(encryptionRotatedSecurity.sessionEpoch);
  });

  it("rotates the explicit revocation epoch and accepts only newly issued admin tokens", async () => {
    configureSecrets();
    const storePath = await createStorePath();
    const modules = await loadSessionModules(storePath);
    const initialSecurity = await modules.adminSecurity.getAdminSessionSecurityState();
    const oldToken = await modules.auth.createSessionToken({ role: "admin", username: "admin", adminSessionEpoch: initialSecurity.sessionEpoch });

    const revokedSecurity = await modules.adminSecurity.revokeAdminSessions();
    await expect(modules.activeAuth.getActiveSessionForToken(oldToken)).resolves.toBeNull();
    expect(revokedSecurity.sessionEpoch).not.toBe(initialSecurity.sessionEpoch);

    const newToken = await modules.auth.createSessionToken({ role: "admin", username: "admin", adminSessionEpoch: revokedSecurity.sessionEpoch });
    await expect(modules.activeAuth.getActiveSessionForToken(newToken)).resolves.toMatchObject({ role: "admin", username: "admin" });
  });

  it("keeps moderator tokens independent of admin credential rotation and preserves deletion revocation", async () => {
    configureSecrets();
    const storePath = await createStorePath();
    const modules = await loadSessionModules(storePath);
    await modules.adminSecurity.getAdminSessionSecurityState();
    await modules.store.updateStore((store) => {
      store.moderators.push({ id: "moderator-id", username: "editor", passwordHash: "scrypt$test", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    });
    const moderatorToken = await modules.auth.createSessionToken({ role: "moderator", username: "editor" });

    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD_TWO;
    await expect(modules.auth.verifySessionToken(moderatorToken)).resolves.toEqual({ role: "moderator", username: "editor" });
    await expect(modules.activeAuth.getActiveSessionForToken(moderatorToken)).resolves.toEqual({ role: "moderator", username: "editor" });

    await modules.store.updateStore((store) => {
      store.moderators = [];
    });
    await expect(modules.activeAuth.getActiveSessionForToken(moderatorToken)).resolves.toBeNull();
  });
});
