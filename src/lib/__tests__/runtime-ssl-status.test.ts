import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isCurrentRuntimeSslStatusSnapshot,
  isRuntimeSslStatusRequestAuthorized,
  readPrivateRuntimeSslStatusSnapshot,
  sanitizeRuntimeSslStatusSnapshot,
  serveRuntimeSslStatusRequest,
} from "@/lib/runtime-ssl-status.mjs";

const tempDirs: string[] = [];
const STATUS_TOKEN = "correct-horse-battery-staple-with-entropy";
const SENSITIVE_VALUES = [
  "/private/app/wiki-store.json",
  "/private/app/ssl",
  "/custom/internal/status",
  "secret.example.com",
  "ACME provider rejected /private/account.key.pem",
  "Certificate SAN does not match secret.example.com",
];
const SENSITIVE_SNAPSHOT = {
  schemaVersion: 99,
  runtimeInstanceId: "private-runtime-instance-id",
  updatedAt: "2026-08-18T10:00:00.000Z",
  phase: "backoff",
  settings: {
    storePath: SENSITIVE_VALUES[0],
    sslStorageDir: SENSITIVE_VALUES[1],
    statusFilePath: "/private/app/status.json",
    statusEndpointPath: SENSITIVE_VALUES[2],
    listenHost: "0.0.0.0",
    httpPort: 80,
    httpsPort: 443,
  },
  domain: { customDomain: SENSITIVE_VALUES[3], enabled: true },
  servers: { httpListening: true, httpsListening: false },
  refresh: {
    lastReason: "startup:/private/app",
    lastStartedAt: "2026-08-18T09:59:00.000Z",
    lastSucceededAt: null,
    lastFailedAt: "2026-08-18T10:00:00.000Z",
    lastErrorMessage: SENSITIVE_VALUES[4],
  },
  certificate: {
    expiresAt: null,
    lastCheckedAt: "2026-08-18T09:59:00.000Z",
    lastRenewalReason: SENSITIVE_VALUES[5],
    lastIssuedAt: null,
    lastIssueFailedAt: "2026-08-18T10:00:00.000Z",
    lastIssueErrorMessage: SENSITIVE_VALUES[4],
  },
  retry: {
    domain: SENSITIVE_VALUES[3],
    failureCount: 2,
    nextAttemptAt: "2026-08-18T10:15:00.000Z",
    lastFailureAt: "2026-08-18T10:00:00.000Z",
    lastErrorMessage: SENSITIVE_VALUES[4],
  },
};

type ResponseRecorder = {
  body: string;
  headers: Record<string, string>;
  statusCode: number;
  writeHead: (statusCode: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
};

const createResponseRecorder = (): ResponseRecorder => {
  const response: ResponseRecorder = {
    body: "",
    headers: {},
    statusCode: 0,
    writeHead: (statusCode, headers) => {
      response.statusCode = statusCode;
      response.headers = headers;
    },
    end: (body) => {
      response.body = body;
    },
  };
  return response;
};

const createTempDir = async (): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-runtime-ssl-status-"));
  tempDirs.push(tempDir);
  return tempDir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("runtime SSL status authentication", () => {
  it("keeps the endpoint disabled when no bearer token is configured", () => {
    expect(isRuntimeSslStatusRequestAuthorized(undefined, "")).toBe(false);
    expect(isRuntimeSslStatusRequestAuthorized("Bearer anything", "   ")).toBe(false);
  });

  it("accepts only the exact configured bearer credential", () => {
    expect(isRuntimeSslStatusRequestAuthorized(`Bearer ${STATUS_TOKEN}`, STATUS_TOKEN)).toBe(true);
    expect(isRuntimeSslStatusRequestAuthorized(`Bearer ${STATUS_TOKEN}x`, STATUS_TOKEN)).toBe(false);
    expect(isRuntimeSslStatusRequestAuthorized(`bearer ${STATUS_TOKEN}`, STATUS_TOKEN)).toBe(false);
    expect(isRuntimeSslStatusRequestAuthorized(STATUS_TOKEN, STATUS_TOKEN)).toBe(false);
  });

  it("returns an indistinguishable not-found response while the endpoint is disabled", () => {
    const response = createResponseRecorder();

    serveRuntimeSslStatusRequest({ method: "GET", headers: {} }, response, { bearerToken: "", snapshot: SENSITIVE_SNAPSHOT });

    expect(response.statusCode).toBe(404);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    expect(response.body).toBe('{"error":"Not Found"}');
    expect(response.body).not.toContain("ACME provider rejected");
    expect(response.body).not.toContain("/private/app");
  });

  it("returns only a generic challenge for missing and incorrect credentials", () => {
    for (const authorization of [undefined, "Bearer incorrect-token"]) {
      const response = createResponseRecorder();
      serveRuntimeSslStatusRequest({ method: "GET", headers: { authorization } }, response, { bearerToken: STATUS_TOKEN, snapshot: SENSITIVE_SNAPSHOT });

      expect(response.statusCode).toBe(401);
      expect(response.body).toBe('{"error":"Unauthorized"}');
      expect(response.body).not.toContain("ACME provider rejected");
      expect(response.body).not.toContain("/private/app");
    }
  });

  it("serves the sanitized health shape only for an authenticated GET", () => {
    const response = createResponseRecorder();
    serveRuntimeSslStatusRequest({ method: "GET", headers: { authorization: `Bearer ${STATUS_TOKEN}` } }, response, { bearerToken: STATUS_TOKEN, snapshot: SENSITIVE_SNAPSHOT });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(sanitizeRuntimeSslStatusSnapshot(SENSITIVE_SNAPSHOT));
    expect(response.body).not.toContain("ACME provider rejected");
    expect(response.body).not.toContain("/private/app");
  });

  it("rejects authenticated non-GET methods without returning status", () => {
    const response = createResponseRecorder();
    serveRuntimeSslStatusRequest({ method: "POST", headers: { authorization: `Bearer ${STATUS_TOKEN}` } }, response, { bearerToken: STATUS_TOKEN, snapshot: SENSITIVE_SNAPSHOT });

    expect(response.statusCode).toBe(405);
    expect(response.headers).toMatchObject({ Allow: "GET" });
    expect(response.body).toBe('{"error":"Method Not Allowed"}');
  });
});

describe("runtime SSL status network sanitization", () => {
  it("retains health signals without exposing paths, domains, ports, reasons, or errors", () => {
    const sanitized = sanitizeRuntimeSslStatusSnapshot(SENSITIVE_SNAPSHOT);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toEqual({
      schemaVersion: 1,
      updatedAt: "2026-08-18T10:00:00.000Z",
      phase: "backoff",
      domain: { enabled: true },
      servers: { httpListening: true, httpsListening: false },
      refresh: {
        lastStartedAt: "2026-08-18T09:59:00.000Z",
        lastSucceededAt: null,
        lastFailedAt: "2026-08-18T10:00:00.000Z",
      },
      certificate: {
        expiresAt: null,
        lastCheckedAt: "2026-08-18T09:59:00.000Z",
        lastIssuedAt: null,
        lastIssueFailedAt: "2026-08-18T10:00:00.000Z",
      },
      retry: {
        failureCount: 2,
        nextAttemptAt: "2026-08-18T10:15:00.000Z",
        lastFailureAt: "2026-08-18T10:00:00.000Z",
      },
    });
    for (const sensitiveValue of SENSITIVE_VALUES) {
      expect(serialized).not.toContain(sensitiveValue);
    }
    expect(serialized).not.toContain("storePath");
    expect(serialized).not.toContain("statusEndpointPath");
    expect(serialized).not.toContain("lastErrorMessage");
  });

  it("normalizes untrusted status values instead of reflecting arbitrary strings", () => {
    expect(sanitizeRuntimeSslStatusSnapshot({ updatedAt: "/private/path", phase: "provider said secret" })).toMatchObject({ updatedAt: null, phase: "unknown" });
  });
});

describe("private runtime SSL status reads", () => {
  it("accepts only a live snapshot from the current custom-server instance", () => {
    expect(isCurrentRuntimeSslStatusSnapshot({ runtimeInstanceId: "current", phase: "https-ready" }, "current")).toBe(true);
    expect(isCurrentRuntimeSslStatusSnapshot({ runtimeInstanceId: "old", phase: "https-ready" }, "current")).toBe(false);
    expect(isCurrentRuntimeSslStatusSnapshot({ runtimeInstanceId: "current", phase: "stopped" }, "current")).toBe(false);
    expect(isCurrentRuntimeSslStatusSnapshot({ runtimeInstanceId: "current", phase: "https-ready" }, "")).toBe(false);
  });

  it("returns null for missing and malformed snapshots", async () => {
    const tempDir = await createTempDir();
    const statusPath = path.join(tempDir, "ssl", "runtime-status.json");

    await expect(readPrivateRuntimeSslStatusSnapshot(statusPath)).resolves.toBeNull();
    await writeFile(statusPath, "{malformed", { encoding: "utf8", mode: 0o600 });
    await expect(readPrivateRuntimeSslStatusSnapshot(statusPath)).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")("repairs private file permissions before returning detailed diagnostics", async () => {
    const tempDir = await createTempDir();
    const statusDirectory = path.join(tempDir, "ssl");
    const statusPath = path.join(statusDirectory, "runtime-status.json");
    const snapshot = { phase: "error", refresh: { lastErrorMessage: "provider detail" } };

    await readPrivateRuntimeSslStatusSnapshot(statusPath);
    await writeFile(statusPath, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o644 });
    await chmod(statusDirectory, 0o755);
    await expect(readPrivateRuntimeSslStatusSnapshot(statusPath)).resolves.toEqual(snapshot);
    expect((await stat(statusDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(statusPath)).mode & 0o777).toBe(0o600);
  });
});
