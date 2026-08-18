import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClientIpRequest } from "@/lib/login-rate-limit";

const requestForIp = (ip: string): ClientIpRequest => ({ headers: new Headers(), ip });

describe("public docs request admission", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("caps per-client concurrency and releases permits idempotently", async () => {
    vi.stubEnv("PUBLIC_DOCS_CLIENT_MAX_REQUESTS", "10");
    vi.stubEnv("PUBLIC_DOCS_GLOBAL_MAX_REQUESTS", "100");
    vi.stubEnv("PUBLIC_DOCS_RATE_WINDOW_SECONDS", "10");
    vi.stubEnv("PUBLIC_DOCS_CLIENT_MAX_CONCURRENCY", "2");
    vi.stubEnv("PUBLIC_DOCS_GLOBAL_MAX_CONCURRENCY", "10");
    vi.resetModules();
    const { acquirePublicDocsAdmissionPermit, resetPublicDocsAdmissionForTests } = await import("@/lib/public-docs-admission");
    resetPublicDocsAdmissionForTests();
    const request = requestForIp("203.0.113.10");
    const permits = Array.from({ length: 2 }, () => acquirePublicDocsAdmissionPermit(request, 1_000));
    expect(permits.every((permit) => permit.allowed)).toBe(true);
    expect(acquirePublicDocsAdmissionPermit(request, 1_000)).toEqual({ allowed: false, retryAfterSeconds: 1 });

    const first = permits[0];
    if (!first?.allowed) {
      throw new Error("Expected an admitted request.");
    }
    first.release();
    first.release();
    expect(acquirePublicDocsAdmissionPermit(request, 1_000).allowed).toBe(true);
  });

  it("rate-limits repeated requests from one known client", async () => {
    vi.stubEnv("PUBLIC_DOCS_CLIENT_MAX_REQUESTS", "3");
    vi.stubEnv("PUBLIC_DOCS_GLOBAL_MAX_REQUESTS", "100");
    vi.stubEnv("PUBLIC_DOCS_RATE_WINDOW_SECONDS", "10");
    vi.stubEnv("PUBLIC_DOCS_CLIENT_MAX_CONCURRENCY", "2");
    vi.stubEnv("PUBLIC_DOCS_GLOBAL_MAX_CONCURRENCY", "10");
    vi.resetModules();
    const { acquirePublicDocsAdmissionPermit, resetPublicDocsAdmissionForTests } = await import("@/lib/public-docs-admission");
    resetPublicDocsAdmissionForTests();
    const request = requestForIp("203.0.113.11");
    for (let index = 0; index < 3; index += 1) {
      const permit = acquirePublicDocsAdmissionPermit(request, 2_000);
      expect(permit.allowed).toBe(true);
      if (permit.allowed) {
        permit.release();
      }
    }

    expect(acquirePublicDocsAdmissionPermit(request, 2_000)).toEqual({ allowed: false, retryAfterSeconds: 10 });
  });
});
