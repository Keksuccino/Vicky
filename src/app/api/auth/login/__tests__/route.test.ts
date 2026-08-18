import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  applySessionCookie: vi.fn(),
  authenticateCredentials: vi.fn(),
  clearFailedLoginAttempts: vi.fn(),
  createSessionToken: vi.fn(),
  getLoginRateLimitStatus: vi.fn(),
  registerFailedLoginAttempt: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ applySessionCookie: mocks.applySessionCookie, createSessionToken: mocks.createSessionToken }));
vi.mock("@/lib/login-rate-limit", () => ({ clearFailedLoginAttempts: mocks.clearFailedLoginAttempts, getLoginRateLimitStatus: mocks.getLoginRateLimitStatus, registerFailedLoginAttempt: mocks.registerFailedLoginAttempt }));
vi.mock("@/lib/moderators", () => ({ authenticateCredentials: mocks.authenticateCredentials }));

import { POST } from "@/app/api/auth/login/route";
import { AdminPasswordVerificationBusyError } from "@/lib/admin-password";
import { AUTH_PASSWORD_MAX_CHARACTERS, AUTH_PASSWORD_MAX_UTF8_BYTES, getUtf8ByteLength, LOGIN_REQUEST_MAX_BYTES, LOGIN_USERNAME_MAX_CHARACTERS, LOGIN_USERNAME_MAX_UTF8_BYTES } from "@/lib/auth-credential-policy.mjs";

const validBody = { username: "admin", password: "admin password" };
const createRequest = (body: unknown = validBody, headers: Record<string, string> = { "content-type": "application/json" }): NextRequest => new NextRequest("https://docs.example.com/api/auth/login", { method: "POST", headers, body: JSON.stringify(body) });
const createStreamedRequest = (chunks: Uint8Array[], headers: Record<string, string> = { "content-type": "application/json" }): NextRequest => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { chunks.forEach((chunk) => controller.enqueue(chunk)); controller.close(); } });
  const init = { method: "POST", headers, body: stream, duplex: "half" } as unknown as NonNullable<ConstructorParameters<typeof NextRequest>[1]>;
  return new NextRequest("https://docs.example.com/api/auth/login", init);
};

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLoginRateLimitStatus.mockResolvedValue({ blocked: false, retryAfterSeconds: 0 });
    mocks.authenticateCredentials.mockResolvedValue({ role: "admin", username: "admin" });
    mocks.createSessionToken.mockResolvedValue("session-token");
  });

  it("preserves the successful login response and session flow", async () => {
    const request = createRequest();
    expect(request.headers.get("content-length")).toBeNull();
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true, role: "admin", username: "admin" });
    expect(mocks.clearFailedLoginAttempts).toHaveBeenCalledOnce();
    expect(mocks.createSessionToken).toHaveBeenCalledWith({ role: "admin", username: "admin" });
    expect(mocks.applySessionCookie).toHaveBeenCalledWith(expect.any(Response), "session-token");
  });

  it("rejects missing and unsupported content types before authentication", async () => {
    const missingContentTypeRequest = createRequest();
    missingContentTypeRequest.headers.delete("content-type");
    const missingContentTypeResponse = await POST(missingContentTypeRequest);
    const wrongContentTypeResponse = await POST(createRequest(validBody, { "content-type": "text/plain" }));

    expect(missingContentTypeResponse.status).toBe(415);
    expect(wrongContentTypeResponse.status).toBe(415);
    expect(mocks.authenticateCredentials).not.toHaveBeenCalled();
  });

  it("rejects misleading and excessive declared lengths before authentication", async () => {
    const mismatchedResponse = await POST(createRequest(validBody, { "content-type": "application/json", "content-length": "1" }));
    const excessiveResponse = await POST(createRequest(validBody, { "content-type": "application/json", "content-length": String(LOGIN_REQUEST_MAX_BYTES + 1) }));

    expect(mismatchedResponse.status).toBe(400);
    expect(excessiveResponse.status).toBe(413);
    expect(mocks.authenticateCredentials).not.toHaveBeenCalled();
  });

  it("enforces the streamed body limit when Content-Length is absent", async () => {
    const fullChunk = new Uint8Array(LOGIN_REQUEST_MAX_BYTES);
    fullChunk.fill(0x20);
    const request = createStreamedRequest([fullChunk, new Uint8Array([0x20])]);
    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(mocks.authenticateCredentials).not.toHaveBeenCalled();
  });

  it("rejects malformed streamed UTF-8 before authentication", async () => {
    const response = await POST(createStreamedRequest([new Uint8Array([0xff])]));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Login request body must be valid UTF-8." });
    expect(mocks.authenticateCredentials).not.toHaveBeenCalled();
  });

  it("enforces username, password character, and password UTF-8 byte limits before authentication", async () => {
    const longUsernameResponse = await POST(createRequest({ ...validBody, username: "u".repeat(LOGIN_USERNAME_MAX_CHARACTERS + 1) }));
    const multibyteUsernameResponse = await POST(createRequest({ ...validBody, username: "🙂".repeat(Math.floor(LOGIN_USERNAME_MAX_UTF8_BYTES / 4) + 1) }));
    const longPasswordResponse = await POST(createRequest({ ...validBody, password: "p".repeat(AUTH_PASSWORD_MAX_CHARACTERS + 1) }));
    const multibytePassword = "🙂".repeat(Math.floor(AUTH_PASSWORD_MAX_UTF8_BYTES / 4) + 1);
    const multibytePasswordResponse = await POST(createRequest({ ...validBody, password: multibytePassword }));

    expect(longUsernameResponse.status).toBe(400);
    expect(multibyteUsernameResponse.status).toBe(400);
    expect(longPasswordResponse.status).toBe(400);
    expect(multibytePasswordResponse.status).toBe(400);
    expect(await multibytePasswordResponse.json()).toEqual({ error: `Password must not exceed ${AUTH_PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes.` });
    expect(mocks.authenticateCredentials).not.toHaveBeenCalled();
  });

  it("accepts a configured password at the shared UTF-8 byte limit", async () => {
    const prefix = "C3dar! orbit maple 7:";
    const remainingBytes = AUTH_PASSWORD_MAX_UTF8_BYTES - getUtf8ByteLength(prefix);
    const password = `${prefix}${"🙂".repeat(Math.floor(remainingBytes / 4))}${"x".repeat(remainingBytes % 4)}`;
    const response = await POST(createRequest({ username: "admin", password }));

    expect(getUtf8ByteLength(password)).toBe(AUTH_PASSWORD_MAX_UTF8_BYTES);
    expect(response.status).toBe(200);
    expect(mocks.authenticateCredentials).toHaveBeenCalledWith("admin", password);
  });

  it("returns a retryable service response when the bounded KDF queue is full", async () => {
    mocks.authenticateCredentials.mockRejectedValueOnce(new AdminPasswordVerificationBusyError());
    const response = await POST(createRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({ error: "Authentication is temporarily busy. Please try again shortly.", retryAfterSeconds: 1 });
    expect(mocks.registerFailedLoginAttempt).not.toHaveBeenCalled();
    expect(mocks.clearFailedLoginAttempts).not.toHaveBeenCalled();
  });
});
