import { describe, expect, it, vi } from "vitest";

import { decideRuntimeRequestAction, getRequestHostname, isHttpsServiceAvailable, routeRuntimeHttpRequest, writeHttpsMaintenanceResponse } from "@/lib/https-runtime-policy.mjs";

const NOW_MS = Date.parse("2026-08-18T12:00:00.000Z");
const DOMAIN = "docs.example.com";

const getAvailability = (overrides: Partial<Parameters<typeof isHttpsServiceAvailable>[0]> = {}): boolean => {
  const availability = {
    configuredDomain: DOMAIN,
    httpsListening: true,
    certificateDomain: DOMAIN,
    certificateValidFromMs: NOW_MS - 60_000,
    certificateExpiresAtMs: NOW_MS + 60_000,
    nowMs: NOW_MS,
    ...overrides,
  };
  return isHttpsServiceAvailable(availability);
};

const getHttpAction = (httpsAvailable: boolean, requestHost: string = DOMAIN, requestUrl: string = "/docs/home") => {
  return decideRuntimeRequestAction({ protocol: "http", configuredDomain: DOMAIN, httpsAvailable, requestHost, requestUrl });
};

describe("fail-closed custom-domain HTTPS policy", () => {
  it("returns maintenance after initial issuance fails and no HTTPS listener is available", () => {
    expect(getAvailability({ httpsListening: false, certificateDomain: "", certificateValidFromMs: 0, certificateExpiresAtMs: 0 })).toBe(false);
    expect(getHttpAction(false)).toBe("maintenance");
  });

  it("rejects an expired installed certificate instead of redirecting HTTP to unusable HTTPS", () => {
    const httpsAvailable = getAvailability({ certificateExpiresAtMs: NOW_MS });

    expect(httpsAvailable).toBe(false);
    expect(getHttpAction(httpsAvailable)).toBe("maintenance");
    expect(decideRuntimeRequestAction({ protocol: "https", configuredDomain: DOMAIN, httpsAvailable, requestHost: DOMAIN, requestUrl: "/" })).toBe("maintenance");
  });

  it("keeps redirecting to HTTPS when renewal fails but the installed certificate remains valid", () => {
    const httpsAvailable = getAvailability({ certificateExpiresAtMs: NOW_MS + 10_000 });

    expect(httpsAvailable).toBe(true);
    expect(getHttpAction(httpsAvailable)).toBe("redirect");
    expect(decideRuntimeRequestAction({ protocol: "https", configuredDomain: DOMAIN, httpsAvailable, requestHost: DOMAIN, requestUrl: "/docs/home" })).toBe("application");
  });

  it("recovers redirects after a newly issued matching certificate becomes active", () => {
    expect(getHttpAction(false)).toBe("maintenance");

    const httpsAvailable = getAvailability({ certificateValidFromMs: NOW_MS, certificateExpiresAtMs: NOW_MS + 90 * 24 * 60 * 60 * 1000 });
    expect(httpsAvailable).toBe(true);
    expect(getHttpAction(httpsAvailable)).toBe("redirect");
  });

  it("always reserves non-empty HTTP-01 challenge paths while fail-closed", () => {
    expect(getHttpAction(false, DOMAIN, "/.well-known/acme-challenge/token-123?probe=1")).toBe("challenge");
    expect(getHttpAction(false, DOMAIN, "/.well-known/acme-challenge/")).toBe("maintenance");
  });

  it("preserves application traffic for localhost and other non-custom HTTP hosts", () => {
    expect(getHttpAction(false, "localhost:3000")).toBe("application");
    expect(getHttpAction(false, "vicky.internal:3000")).toBe("application");
    expect(getHttpAction(true, "vicky.internal:3000")).toBe("application");
  });

  it("does not create canonical redirect loops and accepts an equivalent trailing DNS dot", () => {
    expect(getRequestHostname("Docs.Example.com.:80")).toBe(DOMAIN);
    expect(getHttpAction(true, "Docs.Example.com.:80")).toBe("redirect");
    expect(decideRuntimeRequestAction({ protocol: "https", configuredDomain: DOMAIN, httpsAvailable: true, requestHost: "Docs.Example.com.:443", requestUrl: "/" })).toBe("application");
    expect(decideRuntimeRequestAction({ protocol: "https", configuredDomain: DOMAIN, httpsAvailable: true, requestHost: "legacy.example.com", requestUrl: "/" })).toBe("redirect");
  });

  it("does not guess a hostname from multi-value or malformed direct Host input", () => {
    expect(getRequestHostname("docs.example.com,attacker.example")).toBe("");
    expect(getRequestHostname("user@docs.example.com")).toBe("");
    expect(getRequestHostname("docs.example.com/path")).toBe("");
    expect(getRequestHostname(["docs.example.com"])).toBe("");
  });

  it("returns a static cache-disabled maintenance response without application content", () => {
    let body = "";
    let statusCode = 0;
    let headers: Record<string, string | number> = {};

    const response = {
      writeHead: (nextStatusCode: number, nextHeaders: Record<string, string | number>) => {
        statusCode = nextStatusCode;
        headers = nextHeaders;
      },
      end: (nextBody: string) => {
        body = nextBody;
      },
    };
    writeHttpsMaintenanceResponse(response);

    expect(statusCode).toBe(503);
    expect(headers).toMatchObject({ "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "Retry-After": "300", "X-Content-Type-Options": "nosniff" });
    expect(body).toBe("Secure service is temporarily unavailable while HTTPS is being restored. Please try again later.\n");
    expect(body).not.toContain("docs.example.com");
  });

  it.each([
    { httpsAvailable: true, expectedAction: "redirect" },
    { httpsAvailable: false, expectedAction: "maintenance" },
  ] as const)("enforces $expectedAction before evaluating status authorization", ({ httpsAvailable, expectedAction }) => {
    const serveApplication = vi.fn();
    const serveChallenge = vi.fn();
    const serveMaintenance = vi.fn();
    const serveRedirect = vi.fn();
    const evaluateBearerProtectedStatus = vi.fn(() => true);
    const requestContext = { configuredDomain: DOMAIN, httpsAvailable, requestHost: DOMAIN, requestUrl: "/.well-known/vicky/ssl-status", serveApplication, serveChallenge, serveMaintenance, serveRedirect, serveRuntimeStatus: evaluateBearerProtectedStatus };

    expect(routeRuntimeHttpRequest(requestContext)).toBe(expectedAction);
    expect(evaluateBearerProtectedStatus).not.toHaveBeenCalled();
    expect(serveApplication).not.toHaveBeenCalled();
    expect(serveRedirect).toHaveBeenCalledTimes(expectedAction === "redirect" ? 1 : 0);
    expect(serveMaintenance).toHaveBeenCalledTimes(expectedAction === "maintenance" ? 1 : 0);
  });

  it("evaluates the status handler for a non-custom host without invoking the application", () => {
    const serveApplication = vi.fn();
    const evaluateBearerProtectedStatus = vi.fn(() => true);
    const requestContext = { configuredDomain: DOMAIN, httpsAvailable: false, requestHost: "localhost:3000", requestUrl: "/.well-known/vicky/ssl-status", serveApplication, serveChallenge: vi.fn(), serveMaintenance: vi.fn(), serveRedirect: vi.fn(), serveRuntimeStatus: evaluateBearerProtectedStatus };

    expect(routeRuntimeHttpRequest(requestContext)).toBe("status");
    expect(evaluateBearerProtectedStatus).toHaveBeenCalledOnce();
    expect(serveApplication).not.toHaveBeenCalled();
  });
});
