import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const tempDirs: string[] = [];

const createRequest = (headers: Record<string, string>, ip?: string) =>
  ({
    headers: new Headers(headers),
    ip,
  }) as unknown as NextRequest;

describe("login rate limiting", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  });

  it("uses the internal client IP header only when explicitly trusted", async () => {
    vi.stubEnv("VICKY_TRUST_INTERNAL_CLIENT_IP_HEADER", "true");
    vi.resetModules();

    const { getClientIp } = await import("@/lib/login-rate-limit");

    expect(getClientIp(createRequest({ "x-vicky-client-ip": "203.0.113.10" }))).toBe("203.0.113.10");
  });

  it("prefers trusted proxy headers over the custom server socket address", async () => {
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("VICKY_TRUST_INTERNAL_CLIENT_IP_HEADER", "true");
    vi.resetModules();

    const { getClientIp } = await import("@/lib/login-rate-limit");

    expect(
      getClientIp(
        createRequest({
          "x-forwarded-for": "198.51.100.20, 10.0.0.2",
          "x-vicky-client-ip": "10.0.0.2",
        }),
      ),
    ).toBe("198.51.100.20");
  });

  it.skipIf(process.platform === "win32")("persists rate-limit state in a private directory and file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-"));
    const storePath = path.join(tempDir, "state", "login-rate-limit.json");
    tempDirs.push(tempDir);
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", storePath);
    vi.resetModules();

    const { registerFailedLoginAttempt } = await import("@/lib/login-rate-limit");
    await registerFailedLoginAttempt(createRequest({}, "203.0.113.8"));

    expect((await stat(path.dirname(storePath))).mode & 0o777).toBe(0o700);
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
  });
});
