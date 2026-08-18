import { afterEach, describe, expect, it, vi } from "vitest";

const originalAdminPassword = process.env.ADMIN_PASSWORD;

const restoreAdminPassword = (): void => {
  if (originalAdminPassword === undefined) {
    delete process.env.ADMIN_PASSWORD;
    return;
  }

  process.env.ADMIN_PASSWORD = originalAdminPassword;
};

afterEach(() => {
  restoreAdminPassword();
  vi.resetModules();
});

describe("built-in admin password verification", () => {
  it("verifies the centralized automated-test fallback and rejects a wrong password", async () => {
    delete process.env.ADMIN_PASSWORD;
    const { authenticateCredentials } = await import("@/lib/moderators");

    await expect(authenticateCredentials(" ADMIN ", "Vicky tests: cedar! orbit7 glass")).resolves.toEqual({ role: "admin", username: "admin" });
    await expect(authenticateCredentials("admin", "Vicky tests: cedar! orbit7 glaze")).resolves.toBeNull();
  });

  it("compares the exact UTF-8 password without trimming or Unicode normalization", async () => {
    const expectedPassword = "Café 🔐 river9 maple glass cedar";
    process.env.ADMIN_PASSWORD = expectedPassword;
    const { verifyAdminPassword } = await import("@/lib/admin-password");

    await expect(verifyAdminPassword(expectedPassword)).resolves.toBe(true);
    await expect(verifyAdminPassword(` ${expectedPassword}`)).resolves.toBe(false);
    await expect(verifyAdminPassword(expectedPassword.normalize("NFD"))).resolves.toBe(false);
  });

  it("bounds queued KDF work and reports deterministic saturation", async () => {
    delete process.env.ADMIN_PASSWORD;
    const { AdminPasswordVerificationBusyError, verifyAdminPassword } = await import("@/lib/admin-password");
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => verifyAdminPassword(`wrong password ${index}`)));
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

    expect(rejected).toHaveLength(3);
    expect(rejected.every((result) => result.reason instanceof AdminPasswordVerificationBusyError)).toBe(true);
  }, 30_000);
});
