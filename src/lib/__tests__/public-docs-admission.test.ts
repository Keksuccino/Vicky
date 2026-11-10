import { afterEach, describe, expect, it, vi } from "vitest";

import { INTERNAL_CLIENT_IP_HEADER, type ClientIpRequest } from "@/lib/client-ip-policy";
import { INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER } from "@/lib/request-origin-policy.mjs";

const requestForIp = (ip: string): ClientIpRequest => ({ headers: new Headers(), ip });
const requestForTrustedProxyClient = (clientIp: string): ClientIpRequest => ({ headers: new Headers({ "x-forwarded-for": clientIp, [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: "docs-test-token", [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" }), ip: "192.0.2.90" });

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

  it("uses the trusted ingress client for per-client admission behind one proxy", async () => {
    vi.stubEnv("PUBLIC_DOCS_CLIENT_MAX_REQUESTS", "1");
    vi.stubEnv("PUBLIC_DOCS_GLOBAL_MAX_REQUESTS", "100");
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "docs-test-token");
    vi.resetModules();
    const { acquirePublicDocsAdmissionPermit, resetPublicDocsAdmissionForTests } = await import("@/lib/public-docs-admission");
    resetPublicDocsAdmissionForTests();

    const firstClient = acquirePublicDocsAdmissionPermit(requestForTrustedProxyClient("198.51.100.20"), 3_000);
    expect(firstClient.allowed).toBe(true);
    if (firstClient.allowed) {
      firstClient.release();
    }
    const secondClient = acquirePublicDocsAdmissionPermit(requestForTrustedProxyClient("198.51.100.21"), 3_000);
    expect(secondClient.allowed).toBe(true);
    if (secondClient.allowed) {
      secondClient.release();
    }
    expect(acquirePublicDocsAdmissionPermit(requestForTrustedProxyClient("198.51.100.20"), 3_000).allowed).toBe(false);
  });

  it("admits docs page requests in the included server and lets their render run under that permit", async () => {
    vi.stubEnv("PUBLIC_DOCS_CLIENT_MAX_REQUESTS", "2");
    vi.stubEnv("PUBLIC_DOCS_GLOBAL_MAX_REQUESTS", "100");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "docs-test-token");
    vi.resetModules();
    const { PUBLIC_DOCS_ADMITTED_HEADER, admitPublicDocsPageRequest } = await import("@/lib/public-docs-limiter.mjs");
    const { resetPublicDocsAdmissionForTests, withPublicDocsAdmission } = await import("@/lib/public-docs-admission");
    resetPublicDocsAdmissionForTests();
    const serverRequest = (method: string, extra: Record<string, string> = {}) => ({
      method,
      headers: { [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: "docs-test-token", [INTERNAL_CLIENT_IP_HEADER]: "203.0.113.30", [PUBLIC_DOCS_ADMITTED_HEADER]: "1", ...extra } as Record<string, string>,
    });

    // Client-supplied marks are removed from every request; only docs page reads are admitted here.
    for (const [method, pathname] of [["GET", "/api/docs/page"], ["POST", "/docs/home"], ["GET", "/documents"]]) {
      const request = serverRequest(method);
      expect(admitPublicDocsPageRequest(request, pathname)).toBeNull();
      expect(request.headers[PUBLIC_DOCS_ADMITTED_HEADER]).toBeUndefined();
    }

    const admitted = serverRequest("GET");
    const permit = admitPublicDocsPageRequest(admitted, "/docs/en-US/home");
    expect(permit?.allowed).toBe(true);
    expect(admitted.headers[PUBLIC_DOCS_ADMITTED_HEADER]).toBe("1");

    // The render of the admitted request takes no second permit...
    const work = vi.fn(async () => "rendered");
    await expect(withPublicDocsAdmission({ headers: new Headers(admitted.headers) }, work)).resolves.toBe("rendered");
    // ...and a mark without the server's token counts for nothing.
    await withPublicDocsAdmission({ headers: new Headers({ ...admitted.headers, [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: "forged" }), ip: "203.0.113.30" }, work);

    const throttled = serverRequest("HEAD");
    expect(admitPublicDocsPageRequest(throttled, "/docs")).toMatchObject({ allowed: false });
    expect(throttled.headers[PUBLIC_DOCS_ADMITTED_HEADER]).toBeUndefined();
    if (permit?.allowed) {
      permit.release();
    }
  });

  it("applies only the global admission bucket when no trustworthy client IP exists", async () => {
    vi.stubEnv("PUBLIC_DOCS_CLIENT_MAX_REQUESTS", "1");
    vi.stubEnv("PUBLIC_DOCS_GLOBAL_MAX_REQUESTS", "3");
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "false");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "");
    vi.resetModules();
    const { acquirePublicDocsAdmissionPermit, resetPublicDocsAdmissionForTests } = await import("@/lib/public-docs-admission");
    resetPublicDocsAdmissionForTests();

    for (const spoofedIp of ["198.51.100.20", "198.51.100.21", "198.51.100.22"]) {
      const permit = acquirePublicDocsAdmissionPermit({ headers: new Headers({ "x-forwarded-for": spoofedIp, [INTERNAL_CLIENT_IP_HEADER]: spoofedIp }) }, 4_000);
      expect(permit.allowed).toBe(true);
      if (permit.allowed) {
        permit.release();
      }
    }
    expect(acquirePublicDocsAdmissionPermit({ headers: new Headers() }, 4_000).allowed).toBe(false);
  });
});
