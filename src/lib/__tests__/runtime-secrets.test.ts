import { describe, expect, it } from "vitest";

import { getRuntimeSecret, RuntimeSecretValidationError, validateRuntimeSecrets } from "../runtime-secrets.mjs";

const STRONG_SECRETS = Object.freeze({
  AUTH_JWT_SECRET: "M8vR2kX7pQ4nT9cF6yH1sD5wJ0zB3gLaEeUi",
  ENCRYPTION_SECRET: "C3hN8xW1mK6qP9vR4tY7dF2sL5bJ0zGaAoEu",
  ADMIN_PASSWORD: "cedar orbit! maple7 glass",
});

const explicitTestEnvironment = () => ({ VITEST: "true", VICKY_AUTOMATED_TEST_RUN: "vitest" });

describe("runtime secret validation", () => {
  it("accepts independent random secrets and a strong passphrase", () => {
    expect(validateRuntimeSecrets(STRONG_SECRETS)).toEqual(STRONG_SECRETS);
  });

  it("accepts long passphrases for machine secrets without requiring symbol classes", () => {
    const passphraseSecrets = {
      AUTH_JWT_SECRET: "orchid lantern river copper midnight",
      ENCRYPTION_SECRET: "willow atlas meadow quartz horizon",
      ADMIN_PASSWORD: "cedar orbit maple glass",
    };
    expect(validateRuntimeSecrets(passphraseSecrets)).toEqual(passphraseSecrets);
  });

  it("provides deterministic fallbacks only under the explicit Vitest signal", () => {
    expect(validateRuntimeSecrets(explicitTestEnvironment())).toEqual(validateRuntimeSecrets(explicitTestEnvironment()));
  });

  it("does not trust NODE_ENV=test by itself", () => {
    expect(() => validateRuntimeSecrets({ NODE_ENV: "test" })).toThrow(RuntimeSecretValidationError);
    expect(() => getRuntimeSecret("AUTH_JWT_SECRET", { NODE_ENV: "test" })).toThrow("AUTH_JWT_SECRET is missing");
  });

  it.each([
    { VITEST: "true" },
    { VICKY_AUTOMATED_TEST_RUN: "vitest" },
    { VITEST: "true", VICKY_AUTOMATED_TEST_RUN: "unexpected" },
  ])("requires both exact test-runner signals", (environment) => {
    expect(() => validateRuntimeSecrets(environment)).toThrow(RuntimeSecretValidationError);
  });

  it.each([
    ["AUTH_JWT_SECRET", "replace-with-long-random-secret"],
    ["ENCRYPTION_SECRET", "REPLACE_WITH_LONG_RANDOM_SECRET"],
    ["ADMIN_PASSWORD", "change-this-admin-password"],
    ["ADMIN_PASSWORD", "replace-with-a-strong-password"],
    ["ADMIN_PASSWORD", "password123"],
    ["AUTH_JWT_SECRET", "test-auth-jwt-secret"],
    ["ENCRYPTION_SECRET", "test-encryption-secret"],
  ])("rejects placeholder %s values", (secretName, placeholder) => {
    const environment = { ...STRONG_SECRETS, [secretName]: placeholder };
    expect(() => validateRuntimeSecrets(environment)).toThrow(`${secretName} uses a documented or common placeholder`);
  });

  it("rejects short and predictable values", () => {
    expect(() => validateRuntimeSecrets({ ...STRONG_SECRETS, AUTH_JWT_SECRET: "short" })).toThrow("AUTH_JWT_SECRET must contain at least 32 characters");
    expect(() => validateRuntimeSecrets({ ...STRONG_SECRETS, ENCRYPTION_SECRET: "abababababababababababababababab" })).toThrow("ENCRYPTION_SECRET is too predictable");
    expect(() => validateRuntimeSecrets({ ...STRONG_SECRETS, ADMIN_PASSWORD: "aaaaaaaaaaaaaa" })).toThrow("ADMIN_PASSWORD is too predictable");
  });

  it("rejects reused values without including them in the error", () => {
    const reusedValue = "X4rN8mC2vK7qP1sD9yF6hJ3wL5bT0zGaEeUi";
    let error;
    try {
      validateRuntimeSecrets({ ...STRONG_SECRETS, AUTH_JWT_SECRET: reusedValue, ENCRYPTION_SECRET: reusedValue });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RuntimeSecretValidationError);
    expect(String(error)).toContain("AUTH_JWT_SECRET and ENCRYPTION_SECRET must use different values");
    expect(String(error)).not.toContain(reusedValue);
  });

  it("never includes invalid values in actionable errors", () => {
    const invalidValue = "private-private-private-private-private";
    expect(() => validateRuntimeSecrets({ ...STRONG_SECRETS, AUTH_JWT_SECRET: invalidValue })).toThrow(RuntimeSecretValidationError);

    try {
      validateRuntimeSecrets({ ...STRONG_SECRETS, AUTH_JWT_SECRET: invalidValue });
    } catch (error) {
      expect(String(error)).not.toContain(invalidValue);
      expect(String(error)).toContain("Generate independent secrets before starting Vicky");
    }
  });
});
