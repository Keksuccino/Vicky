import { describe, expect, it } from "vitest";

import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "../domain-settings";

describe("domain settings normalization", () => {
  it("normalizes hostnames and strips protocol/path", () => {
    expect(normalizeCustomDomain("https://Docs.Example.com/")).toBe("docs.example.com");
    expect(normalizeCustomDomain("docs.example.com")).toBe("docs.example.com");
  });

  it("rejects invalid domain inputs", () => {
    expect(normalizeCustomDomain("")).toBe("");
    expect(normalizeCustomDomain("localhost")).toBe("");
    expect(normalizeCustomDomain("https://example.com/docs")).toBe("");
    expect(normalizeCustomDomain("example..com")).toBe("");
  });

  it("normalizes and validates lets encrypt email", () => {
    expect(normalizeLetsEncryptEmail("Admin@Example.com")).toBe("admin@example.com");
    expect(normalizeLetsEncryptEmail("invalid-email")).toBe("");
  });
});
