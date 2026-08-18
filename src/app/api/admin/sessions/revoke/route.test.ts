import { NextRequest, NextResponse } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearSessionCookie: vi.fn(),
  requireAdminRequest: vi.fn(),
  revokeAdminSessions: vi.fn(),
}));

vi.mock("@/lib/active-auth", () => ({ requireAdminRequest: mocks.requireAdminRequest }));
vi.mock("@/lib/admin-session-security", () => ({ revokeAdminSessions: mocks.revokeAdminSessions }));
vi.mock("@/lib/auth", () => ({ clearSessionCookie: mocks.clearSessionCookie }));

import { POST } from "./route";

const createRequest = (): NextRequest => new NextRequest("https://docs.example.com/api/admin/sessions/revoke", { method: "POST" });

describe("POST /api/admin/sessions/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminRequest.mockResolvedValue(null);
    mocks.revokeAdminSessions.mockResolvedValue({ sessionEpoch: "rotated", credentialFingerprint: "fingerprint" });
  });

  it("revokes all built-in admin sessions and clears the caller cookie", async () => {
    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(mocks.revokeAdminSessions).toHaveBeenCalledOnce();
    expect(mocks.clearSessionCookie).toHaveBeenCalledWith(expect.any(Response));
  });

  it("does not rotate state for an unauthorized request", async () => {
    mocks.requireAdminRequest.mockResolvedValueOnce(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    expect(mocks.revokeAdminSessions).not.toHaveBeenCalled();
    expect(mocks.clearSessionCookie).not.toHaveBeenCalled();
  });
});
