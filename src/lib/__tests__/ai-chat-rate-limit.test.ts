import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { INTERNAL_CLIENT_IP_HEADER } from "@/lib/client-ip-policy";
import { INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER } from "@/lib/request-origin-policy.mjs";

const createRequest = (headers: Record<string, string>): NextRequest => ({ headers: new Headers(headers) }) as unknown as NextRequest;
const createTrustedProxyRequest = (clientIp: string): NextRequest => createRequest({ "x-forwarded-for": clientIp, [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: "ai-rate-token", [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" });

describe("AI chat rate limiting client identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("separates trusted ingress clients sharing one proxy peer", async () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "ai-rate-token");
    vi.resetModules();
    const { consumeAiChatRateLimit } = await import("@/lib/ai-chat-rate-limit");

    for (let index = 0; index < 12; index += 1) {
      expect(consumeAiChatRateLimit(createTrustedProxyRequest("198.51.100.20")).blocked).toBe(false);
    }
    expect(consumeAiChatRateLimit(createTrustedProxyRequest("198.51.100.20")).blocked).toBe(true);
    expect(consumeAiChatRateLimit(createTrustedProxyRequest("198.51.100.21")).blocked).toBe(false);
  });

  it("does not let untrusted forwarded spoofing evade the unknown global fallback", async () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "false");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", "");
    vi.resetModules();
    const { consumeAiChatRateLimit } = await import("@/lib/ai-chat-rate-limit");

    for (let index = 0; index < 12; index += 1) {
      expect(consumeAiChatRateLimit(createRequest({ "x-forwarded-for": `198.51.100.${index + 1}` })).blocked).toBe(false);
    }
    expect(consumeAiChatRateLimit(createRequest({ "x-forwarded-for": "198.51.100.200" })).blocked).toBe(true);
  });
});
