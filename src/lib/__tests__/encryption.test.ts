import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptSecret, encryptSecret } from "../encryption";

describe("encryption", () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalSecret = process.env.ENCRYPTION_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.ENCRYPTION_SECRET;
    } else {
      process.env.ENCRYPTION_SECRET = originalSecret;
    }

    if (originalNodeEnv === undefined) {
      delete mutableEnv.NODE_ENV;
    } else {
      mutableEnv.NODE_ENV = originalNodeEnv;
    }

    vi.restoreAllMocks();
  });

  it("round-trips encrypted values", () => {
    process.env.ENCRYPTION_SECRET = "test-secret";

    const encrypted = encryptSecret("ghp_abc123");
    expect(encrypted).not.toBe("ghp_abc123");

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe("ghp_abc123");
  });

  it("returns empty string for empty payload", () => {
    process.env.ENCRYPTION_SECRET = "test-secret";

    expect(decryptSecret("")).toBe("");
    expect(decryptSecret(null)).toBe("");
  });

  it("throws on invalid payload format", () => {
    process.env.ENCRYPTION_SECRET = "test-secret";

    expect(() => decryptSecret("invalid-value")).toThrow("Encrypted payload format is invalid.");
  });

  it("throws outside tests when secret is missing", () => {
    delete process.env.ENCRYPTION_SECRET;
    mutableEnv.NODE_ENV = "development";

    expect(() => encryptSecret("abc")).toThrow("Missing ENCRYPTION_SECRET environment variable.");
  });

  it("throws in production when secret is missing", () => {
    delete process.env.ENCRYPTION_SECRET;
    mutableEnv.NODE_ENV = "production";

    expect(() => encryptSecret("abc")).toThrow("Missing ENCRYPTION_SECRET environment variable.");
  });
});
