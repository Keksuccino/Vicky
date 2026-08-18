import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptSecret, encryptSecret } from "../encryption";

describe("encryption", () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const originalSecret = process.env.ENCRYPTION_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVitestSignal = process.env.VITEST;
  const originalAutomatedTestSignal = process.env.VICKY_AUTOMATED_TEST_RUN;

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

    if (originalVitestSignal === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitestSignal;
    }

    if (originalAutomatedTestSignal === undefined) {
      delete process.env.VICKY_AUTOMATED_TEST_RUN;
    } else {
      process.env.VICKY_AUTOMATED_TEST_RUN = originalAutomatedTestSignal;
    }

    vi.restoreAllMocks();
  });

  it("round-trips encrypted values", () => {
    process.env.ENCRYPTION_SECRET = "L8yQ3kV7pN1xW6mF9rT2cD5hJ0sB4zAaEeUi";

    const encrypted = encryptSecret("ghp_abc123");
    expect(encrypted).not.toBe("ghp_abc123");

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe("ghp_abc123");
  });

  it("returns empty string for empty payload", () => {
    process.env.ENCRYPTION_SECRET = "L8yQ3kV7pN1xW6mF9rT2cD5hJ0sB4zAaEeUi";

    expect(decryptSecret("")).toBe("");
    expect(decryptSecret(null)).toBe("");
  });

  it("throws on invalid payload format", () => {
    process.env.ENCRYPTION_SECRET = "L8yQ3kV7pN1xW6mF9rT2cD5hJ0sB4zAaEeUi";

    expect(() => decryptSecret("invalid-value")).toThrow("Encrypted payload format is invalid.");
  });

  it("throws outside tests when secret is missing", () => {
    delete process.env.ENCRYPTION_SECRET;
    delete process.env.VITEST;
    delete process.env.VICKY_AUTOMATED_TEST_RUN;
    mutableEnv.NODE_ENV = "development";

    expect(() => encryptSecret("abc")).toThrow("ENCRYPTION_SECRET is missing");
  });

  it("throws in production when secret is missing", () => {
    delete process.env.ENCRYPTION_SECRET;
    delete process.env.VITEST;
    delete process.env.VICKY_AUTOMATED_TEST_RUN;
    mutableEnv.NODE_ENV = "production";

    expect(() => encryptSecret("abc")).toThrow("ENCRYPTION_SECRET is missing");
  });
});
