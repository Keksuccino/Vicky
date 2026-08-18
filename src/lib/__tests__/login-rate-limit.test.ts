import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { INTERNAL_CLIENT_IP_HEADER } from "@/lib/client-ip-policy";
import { INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER } from "@/lib/request-origin-policy.mjs";

const tempDirs: string[] = [];
const INTERNAL_TOKEN = "login-test-process-token";

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

  it("keeps login attempt buckets separate by the trusted ingress client rather than the proxy peer", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-proxy-"));
    const storePath = path.join(tempDir, "login-rate-limit.json");
    tempDirs.push(tempDir);
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", storePath);
    vi.stubEnv("AUTH_LOGIN_MAX_FAILURES", "2");
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", INTERNAL_TOKEN);
    vi.resetModules();

    const { registerFailedLoginAttempt } = await import("@/lib/login-rate-limit");
    const requestForClient = (clientIp: string): NextRequest => createRequest({ "x-forwarded-for": clientIp, [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: INTERNAL_TOKEN, [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" }, "192.0.2.99");
    expect(await registerFailedLoginAttempt(requestForClient("198.51.100.20"))).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(await registerFailedLoginAttempt(requestForClient("198.51.100.21"))).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(await registerFailedLoginAttempt(requestForClient("198.51.100.20"))).toMatchObject({ blocked: true, attemptsLeft: 0 });
  });

  it("uses one deliberate global fallback bucket when login request IP is unknown", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-unknown-"));
    const storePath = path.join(tempDir, "login-rate-limit.json");
    tempDirs.push(tempDir);
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", storePath);
    vi.stubEnv("AUTH_LOGIN_MAX_FAILURES", "2");
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "false");
    vi.resetModules();

    const { registerFailedLoginAttempt } = await import("@/lib/login-rate-limit");
    expect(await registerFailedLoginAttempt(createRequest({ "x-forwarded-for": "198.51.100.20" }))).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(await registerFailedLoginAttempt(createRequest({ "x-forwarded-for": "198.51.100.21" }))).toMatchObject({ blocked: true, attemptsLeft: 0 });
  });

  it("merges legacy equivalent IP spellings when loading persisted login attempts", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-canonical-"));
    const storePath = path.join(tempDir, "login-rate-limit.json");
    const now = Date.now();
    tempDirs.push(tempDir);
    await writeFile(storePath, JSON.stringify({ version: 1, entries: { "192.0.2.128": { failedAt: [now - 2_000], blockedUntil: 0, lastSeenAt: now - 2_000 }, "::ffff:192.0.2.128": { failedAt: [now - 1_000], blockedUntil: 0, lastSeenAt: now - 1_000 } } }));
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", storePath);
    vi.stubEnv("AUTH_LOGIN_MAX_FAILURES", "3");
    vi.stubEnv("AUTH_LOGIN_WINDOW_SECONDS", "600");
    vi.resetModules();

    const { registerFailedLoginAttempt } = await import("@/lib/login-rate-limit");
    expect(await registerFailedLoginAttempt(createRequest({}, "192.0.2.128"))).toMatchObject({ blocked: true, attemptsLeft: 0 });
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
