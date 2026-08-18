import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getPlaintextDocsExport: vi.fn(),
  getStore: vi.fn(),
  resolveRuntimeConfig: vi.fn(),
  setCacheTtl: vi.fn(),
}));

vi.mock("@/lib/cache", () => ({ setDocsCacheTtlMs: mocks.setCacheTtl }));
vi.mock("@/lib/docs-plaintext", () => ({ getPlaintextDocsExport: mocks.getPlaintextDocsExport }));
vi.mock("@/lib/github", () => ({ resolveRuntimeConfig: mocks.resolveRuntimeConfig }));
vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));

import { GET } from "@/app/docs.txt/route";
import { ApiError, PUBLIC_ERROR_LOG_MAX_LENGTH } from "@/lib/http";

const originalTrustProxyOriginHeaders = process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS;

const createRequest = (headers: Record<string, string> = {}): NextRequest => new NextRequest("https://docs.example.com/docs.txt", { headers: { host: "docs.example.com", ...headers } });

describe("GET /docs.txt error responses", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS = "false";
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getStore.mockResolvedValue({ settings: { docsCacheTtlMs: 60_000, github: {} } });
    mocks.resolveRuntimeConfig.mockReturnValue({ branch: "main", docsPath: "docs", owner: "owner", repo: "repo", token: "token" });
    mocks.getPlaintextDocsExport.mockResolvedValue("# Export");
  });

  afterEach(() => {
    consoleError.mockRestore();
    if (originalTrustProxyOriginHeaders === undefined) {
      delete process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS;
    } else {
      process.env.VICKY_TRUST_PROXY_ORIGIN_HEADERS = originalTrustProxyOriginHeaders;
    }
  });

  it("uses the configured canonical domain for plaintext links and cache identity", async () => {
    mocks.getStore.mockResolvedValueOnce({ settings: { docsCacheTtlMs: 60_000, domain: { customDomain: "Canonical.Example.com" }, github: {} } });
    const response = await GET(createRequest({ host: "direct.example.com", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" }));

    expect(response.status).toBe(200);
    expect(mocks.getPlaintextDocsExport).toHaveBeenCalledWith(expect.any(Object), "https://canonical.example.com");
  });

  it("does not let untrusted forwarding change the direct public origin", async () => {
    const response = await GET(createRequest({ host: "direct.example.com:8443", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" }));

    expect(response.status).toBe(200);
    expect(mocks.getPlaintextDocsExport).toHaveBeenCalledWith(expect.any(Object), "https://direct.example.com:8443");
  });

  it("sanitizes unexpected cause chains and redacts their server diagnostic", async () => {
    const secret = "plaintext-export-secret";
    const cause = new Error(`Snapshot read failed token=${secret}`);
    mocks.getPlaintextDocsExport.mockRejectedValueOnce(new Error("Plaintext export failed", { cause }));

    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("Cause: Error: Snapshot read failed token=[REDACTED]");
    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(secret);
  });

  it("hard-bounds the complete redacted diagnostic for deep and long cause chains", async () => {
    const secret = "deep-cause-secret-value";
    let cause: unknown = `authorization=Bearer ${secret}`;
    for (let index = 0; index < 8; index += 1) {
      cause = new Error(`${"x".repeat(700)} token=${secret}-${index} ${"y".repeat(700)}`, { cause });
    }
    mocks.getPlaintextDocsExport.mockRejectedValueOnce(cause);

    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]).toHaveLength(1);
    const diagnostic = String(consoleError.mock.calls[0]?.[0]);
    expect(diagnostic).toHaveLength(PUBLIC_ERROR_LOG_MAX_LENGTH);
    expect(diagnostic).toContain("token=[REDACTED]");
    expect(diagnostic).not.toContain(secret);
  });

  it("omits a very large sensitive component before logging", async () => {
    const secret = "very-large-message-secret";
    mocks.getPlaintextDocsExport.mockRejectedValueOnce(new Error(`token=${secret} ${"x".repeat(1_000_000)}`));

    const response = await GET(createRequest());

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError.mock.calls[0]).toHaveLength(1);
    const diagnostic = String(consoleError.mock.calls[0]?.[0]);
    expect(diagnostic.length).toBeLessThanOrEqual(PUBLIC_ERROR_LOG_MAX_LENGTH);
    expect(diagnostic).toContain("Error: [oversized error detail omitted]");
    expect(diagnostic).not.toContain(secret);
  });

  it("preserves explicitly public ApiError messages and headers", async () => {
    mocks.getPlaintextDocsExport.mockRejectedValueOnce(new ApiError(503, "The docs export is temporarily unavailable.", { "Retry-After": "8" }));

    const response = await GET(createRequest());

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("The docs export is temporarily unavailable.");
    expect(response.headers.get("retry-after")).toBe("8");
    expect(consoleError).not.toHaveBeenCalled();
  });
});
