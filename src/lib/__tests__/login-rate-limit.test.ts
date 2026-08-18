import { fork, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { INTERNAL_CLIENT_IP_HEADER } from "@/lib/client-ip-policy";
import { createLoginRateLimitStorage } from "@/lib/login-rate-limit-storage.mjs";
import { INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER } from "@/lib/request-origin-policy.mjs";

const tempDirs: string[] = [];
const openStorages: Array<{ close: () => void }> = [];
const childProcesses: ChildProcess[] = [];
const loadedLimiterModules: Array<{ resetLoginRateLimitStorageForTests: () => void }> = [];
const INTERNAL_TOKEN = "login-test-process-token";
const WORKER_PATH = fileURLToPath(new URL("./fixtures/login-rate-limit-worker.mjs", import.meta.url));

const createRequest = (headers: Record<string, string>, ip?: string) => ({ headers: new Headers(headers), ip }) as unknown as NextRequest;

const createConfig = (dbPath: string, now: number, overrides: Record<string, unknown> = {}) => ({
  dbPath,
  legacyStorePath: null,
  maxFailures: 8,
  windowMs: 10 * 60 * 1000,
  blockMs: 3 * 60 * 60 * 1000,
  entryTtlMs: 6 * 60 * 60 * 1000,
  maxIdentities: 10_000,
  busyTimeoutMs: 5_000,
  pruneInterval: 64,
  now: () => now,
  ...overrides,
});

const openStorage = (config: ReturnType<typeof createConfig>) => {
  const storage = createLoginRateLimitStorage(config);
  openStorages.push(storage);
  return storage;
};

const importLimiter = async () => {
  vi.resetModules();
  const limiter = await import("@/lib/login-rate-limit");
  loadedLimiterModules.push(limiter);
  return limiter;
};

type WorkerMessage = { type: "ready" } | { type: "result"; results: Array<{ blocked: boolean; blockedUntil: number }> } | { type: "error"; message: string };

const createWorker = (config: Record<string, unknown>, identity: string, attempts: number, now: number) => {
  const encodedConfig = Buffer.from(JSON.stringify(config)).toString("base64url");
  const child = fork(WORKER_PATH, [encodedConfig, identity, String(attempts), String(now)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  childProcesses.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  let readyResolve: (() => void) | null = null;
  let readyReject: ((error: Error) => void) | null = null;
  let resultResolve: ((results: Array<{ blocked: boolean; blockedUntil: number }>) => void) | null = null;
  let resultReject: ((error: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise<Array<{ blocked: boolean; blockedUntil: number }>>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  child.on("message", (message: WorkerMessage) => {
    if (message.type === "ready") {
      readyResolve?.();
    } else if (message.type === "result") {
      resultResolve?.(message.results);
    } else {
      resultReject?.(new Error(message.message));
    }
  });
  child.once("error", (error) => { readyReject?.(error); resultReject?.(error); });
  child.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error(`Login limiter worker exited with ${String(code)}: ${stderr}`);
      readyReject?.(error);
      resultReject?.(error);
    }
  });

  return { child, ready, result };
};

const runConcurrentWorkers = async (config: Record<string, unknown>, identity: string, workers: number, attemptsPerWorker: number, now: number) => {
  const launched = Array.from({ length: workers }, () => createWorker(config, identity, attemptsPerWorker, now));
  await Promise.all(launched.map((worker) => worker.ready));
  launched.forEach((worker) => worker.child.send("go"));
  return (await Promise.all(launched.map((worker) => worker.result))).flat();
};

afterEach(async () => {
  for (const limiter of loadedLimiterModules.splice(0)) {
    limiter.resetLoginRateLimitStorageForTests();
  }
  for (const storage of openStorages.splice(0)) {
    storage.close();
  }
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null) {
      child.kill();
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("login rate limiting", () => {
  it("keeps trusted ingress clients separate and uses one explicit unknown bucket", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-identity-"));
    tempDirs.push(tempDir);
    vi.stubEnv("AUTH_LOGIN_DB_PATH", path.join(tempDir, "login-rate-limit.sqlite"));
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", path.join(tempDir, "legacy.json"));
    vi.stubEnv("AUTH_LOGIN_MAX_FAILURES", "2");
    vi.stubEnv("AUTH_TRUST_PROXY_HEADERS", "true");
    vi.stubEnv("AUTH_TRUSTED_PROXY_IPS", "10.0.0.2");
    vi.stubEnv("VICKY_INTERNAL_REQUEST_CONTEXT_TOKEN", INTERNAL_TOKEN);
    const { registerFailedLoginAttempt } = await importLimiter();
    const trustedRequest = (clientIp: string): NextRequest => createRequest({ "x-forwarded-for": clientIp, [INTERNAL_REQUEST_CONTEXT_TOKEN_HEADER]: INTERNAL_TOKEN, [INTERNAL_CLIENT_IP_HEADER]: "10.0.0.2" }, "192.0.2.99");

    expect(await registerFailedLoginAttempt(trustedRequest("198.51.100.20"))).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(await registerFailedLoginAttempt(trustedRequest("198.51.100.21"))).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(await registerFailedLoginAttempt(trustedRequest("198.51.100.20"))).toMatchObject({ blocked: true, attemptsLeft: 0 });

    const unknownRequest = createRequest({ "x-forwarded-for": "203.0.113.1" });
    const otherUnknownRequest = createRequest({ "x-forwarded-for": "203.0.113.2" });
    expect(await registerFailedLoginAttempt(unknownRequest)).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(await registerFailedLoginAttempt(otherUnknownRequest)).toMatchObject({ blocked: true, attemptsLeft: 0 });
  });

  it("applies sliding-window failures, one non-extending block, expiry, and atomic clear", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-state-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    const start = 2_000_000_000_000;
    const storage = openStorage(createConfig(dbPath, start, { maxFailures: 3, windowMs: 1_000, blockMs: 5_000, entryTtlMs: 10_000 }));

    expect(storage.registerFailure("192.0.2.1", start)).toMatchObject({ blocked: false, attemptsLeft: 2 });
    expect(storage.registerFailure("192.0.2.1", start + 500)).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(storage.registerFailure("192.0.2.1", start + 1_001)).toMatchObject({ blocked: false, attemptsLeft: 1 });
    const blocked = storage.registerFailure("192.0.2.1", start + 1_100);
    expect(blocked).toMatchObject({ blocked: true, attemptsLeft: 0, blockedUntil: start + 6_100 });
    expect(storage.registerFailure("192.0.2.1", start + 2_000)).toMatchObject({ blocked: true, blockedUntil: start + 6_100 });
    expect(storage.getStatus("192.0.2.1", start + 6_100)).toMatchObject({ blocked: false, retryAfterSeconds: 0 });
    storage.clear("192.0.2.1", start + 6_100);
    expect(storage.registerFailure("192.0.2.1", start + 6_101)).toMatchObject({ blocked: false, attemptsLeft: 2 });
  });

  it("performs blocked and expired status reads without changing durable state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-read-only-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    const start = 2_000_000_000_000;
    const storage = openStorage(createConfig(dbPath, start, { maxFailures: 2, blockMs: 2_000 }));
    storage.registerFailure("192.0.2.2", start);
    storage.registerFailure("192.0.2.2", start + 1);

    const inspectionDb = new Database(dbPath);
    inspectionDb.exec("CREATE TABLE write_guard (writes INTEGER NOT NULL); INSERT INTO write_guard VALUES (0);");
    inspectionDb.exec("CREATE TRIGGER guard_entries_update AFTER UPDATE ON login_rate_limit_entries BEGIN UPDATE write_guard SET writes = writes + 1; END;");
    inspectionDb.exec("CREATE TRIGGER guard_entries_delete AFTER DELETE ON login_rate_limit_entries BEGIN UPDATE write_guard SET writes = writes + 1; END;");
    inspectionDb.exec("CREATE TRIGGER guard_failures_delete AFTER DELETE ON login_rate_limit_failures BEGIN UPDATE write_guard SET writes = writes + 1; END;");

    expect(storage.getStatus("192.0.2.2", start + 10)).toMatchObject({ blocked: true });
    expect(storage.getStatus("192.0.2.2", start + 2_001)).toMatchObject({ blocked: false });
    expect(inspectionDb.prepare("SELECT writes FROM write_guard").pluck().get()).toBe(0);
    inspectionDb.close();
  });

  it("migrates canonicalized legacy JSON once and preserves the source file untouched", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-migration-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    const legacyPath = path.join(tempDir, "login-rate-limit.json");
    const now = 2_000_000_000_000;
    const legacyRaw = JSON.stringify({ version: 1, entries: { "192.0.2.128": { failedAt: [now - 2_000], blockedUntil: 0, lastSeenAt: now - 2_000 }, "::ffff:192.0.2.128": { failedAt: [now - 1_000], blockedUntil: 0, lastSeenAt: now - 1_000 }, "198.51.100.9": { failedAt: [], blockedUntil: now + 3_000, lastSeenAt: now - 500 } } });
    await writeFile(legacyPath, legacyRaw);
    const config = createConfig(dbPath, now, { legacyStorePath: legacyPath, maxFailures: 3 });
    const storage = openStorage(config);

    expect(storage.getStatus("198.51.100.9", now)).toMatchObject({ blocked: true, retryAfterSeconds: 3 });
    expect(storage.registerFailure("192.0.2.128", now)).toMatchObject({ blocked: true, attemptsLeft: 0 });
    expect(await readFile(legacyPath, "utf8")).toBe(legacyRaw);
    if (process.platform !== "win32") {
      expect((await stat(legacyPath)).mode & 0o777).toBe(0o600);
    }
    storage.clear("192.0.2.128", now);
    storage.close();
    openStorages.splice(openStorages.indexOf(storage), 1);
    const reopened = openStorage(config);
    expect(reopened.getStatus("192.0.2.128", now)).toMatchObject({ blocked: false });
    expect(await readFile(legacyPath, "utf8")).toBe(legacyRaw);
  });

  it("preserves corrupt legacy state, logs a bounded diagnostic, and activates one conservative global block", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-corrupt-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    const legacyPath = path.join(tempDir, "login-rate-limit.json");
    const corruptRaw = "{malformed";
    const now = 2_000_000_000_000;
    await writeFile(legacyPath, corruptRaw);
    vi.stubEnv("AUTH_LOGIN_DB_PATH", dbPath);
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", legacyPath);
    vi.stubEnv("AUTH_LOGIN_BLOCK_SECONDS", "5");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getLoginRateLimitStatus } = await importLimiter();

    expect(await getLoginRateLimitStatus(createRequest({}, "192.0.2.3"))).toEqual({ blocked: true, retryAfterSeconds: 5 });
    expect(await getLoginRateLimitStatus(createRequest({}, "192.0.2.4"))).toEqual({ blocked: true, retryAfterSeconds: 5 });
    expect(warning).toHaveBeenCalledOnce();
    expect(String(warning.mock.calls[0][0]).length).toBeLessThan(500);
    expect(await readFile(legacyPath, "utf8")).toBe(corruptRaw);
  });

  it("bounds identities with the global unknown fallback and opportunistically prunes stale state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-prune-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    const start = 2_000_000_000_000;
    const storage = openStorage(createConfig(dbPath, start, { maxFailures: 5, maxIdentities: 2, windowMs: 100, blockMs: 100, entryTtlMs: 200 }));
    storage.registerFailure("192.0.2.10", start);
    storage.registerFailure("192.0.2.11", start);
    expect(storage.registerFailure("192.0.2.12", start)).toMatchObject({ identity: "unknown", attemptsLeft: 4 });
    expect(storage.registerFailure("192.0.2.13", start + 1)).toMatchObject({ identity: "unknown", attemptsLeft: 3 });

    const inspectionDb = new Database(dbPath);
    expect(inspectionDb.prepare("SELECT COUNT(*) FROM login_rate_limit_entries").pluck().get()).toBe(3);
    storage.registerFailure("192.0.2.14", start + 202);
    expect(inspectionDb.prepare("SELECT identity FROM login_rate_limit_entries ORDER BY identity").pluck().all()).toEqual(["192.0.2.14"]);
    inspectionDb.close();
  });

  it.skipIf(process.platform === "win32")("keeps the SQLite database and every live sidecar private", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-permissions-"));
    tempDirs.push(tempDir);
    const stateDir = path.join(tempDir, "state");
    const dbPath = path.join(stateDir, "login-rate-limit.sqlite");
    const storage = openStorage(createConfig(dbPath, Date.now()));
    storage.registerFailure("203.0.113.8");
    const sqliteFiles = (await readdir(stateDir)).filter((fileName) => fileName.startsWith("login-rate-limit.sqlite"));

    expect(sqliteFiles).toEqual(expect.arrayContaining(["login-rate-limit.sqlite", "login-rate-limit.sqlite-shm", "login-rate-limit.sqlite-wal"]));
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    await Promise.all(sqliteFiles.map(async (fileName) => expect((await stat(path.join(stateDir, fileName))).mode & 0o777).toBe(0o600)));
    await chmod(stateDir, 0o755);
    await Promise.all(sqliteFiles.map((fileName) => chmod(path.join(stateDir, fileName), 0o666)));
    storage.verifyPrivateFiles();
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    await Promise.all(sqliteFiles.map(async (fileName) => expect((await stat(path.join(stateDir, fileName))).mode & 0o777).toBe(0o600)));
  });

  it("retains bounded in-memory protection when SQLite is busy and suppresses repeated diagnostics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-busy-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    const initializer = openStorage(createConfig(dbPath, Date.now()));
    initializer.close();
    openStorages.splice(openStorages.indexOf(initializer), 1);
    const lockDb = new Database(dbPath);
    lockDb.exec("BEGIN IMMEDIATE");
    vi.stubEnv("AUTH_LOGIN_DB_PATH", dbPath);
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", path.join(tempDir, "legacy.json"));
    vi.stubEnv("AUTH_LOGIN_MAX_FAILURES", "2");
    vi.stubEnv("AUTH_LOGIN_DB_BUSY_TIMEOUT_MS", "1");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getLoginRateLimitStatus, registerFailedLoginAttempt } = await importLimiter();
    const request = createRequest({}, "203.0.113.20");

    expect(await registerFailedLoginAttempt(request)).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(await registerFailedLoginAttempt(request)).toMatchObject({ blocked: true, attemptsLeft: 0 });
    expect(await getLoginRateLimitStatus(request)).toMatchObject({ blocked: true });
    expect(warning).toHaveBeenCalledOnce();
    lockDb.exec("COMMIT");
    lockDb.close();
    expect(await getLoginRateLimitStatus(request)).toMatchObject({ blocked: true });
  });

  it("keeps bounded fallback protection when the durable path cannot be opened", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-failure-"));
    tempDirs.push(tempDir);
    const nonDirectory = path.join(tempDir, "not-a-directory");
    await writeFile(nonDirectory, "occupied");
    vi.stubEnv("AUTH_LOGIN_DB_PATH", path.join(nonDirectory, "login-rate-limit.sqlite"));
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", path.join(tempDir, "legacy.json"));
    vi.stubEnv("AUTH_LOGIN_MAX_FAILURES", "2");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getLoginRateLimitStatus, registerFailedLoginAttempt } = await importLimiter();
    const request = createRequest({}, "203.0.113.21");

    expect(await registerFailedLoginAttempt(request)).toMatchObject({ blocked: false, attemptsLeft: 1 });
    expect(await registerFailedLoginAttempt(request)).toMatchObject({ blocked: true, attemptsLeft: 0 });
    expect(await getLoginRateLimitStatus(request)).toMatchObject({ blocked: true });
    expect(warning).toHaveBeenCalledOnce();
  });

  it("observes another process's successful clear without retaining a stale durable mirror", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-cross-clear-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    vi.stubEnv("AUTH_LOGIN_DB_PATH", dbPath);
    vi.stubEnv("AUTH_LOGIN_STORE_FILE_PATH", path.join(tempDir, "legacy.json"));
    vi.stubEnv("AUTH_LOGIN_MAX_FAILURES", "2");
    const { getLoginRateLimitStatus, registerFailedLoginAttempt } = await importLimiter();
    const request = createRequest({}, "203.0.113.22");
    await registerFailedLoginAttempt(request);
    expect(await registerFailedLoginAttempt(request)).toMatchObject({ blocked: true });

    const clearingDb = new Database(dbPath);
    clearingDb.prepare("DELETE FROM login_rate_limit_entries WHERE identity = ?").run("203.0.113.22");
    clearingDb.close();
    expect(await getLoginRateLimitStatus(request)).toEqual({ blocked: false, retryAfterSeconds: 0 });
  });

  it("does not lose failures when real processes update one database concurrently", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-process-count-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    const now = 2_000_000_000_000;
    const config = createConfig(dbPath, now, { maxFailures: 100 });
    const initializer = openStorage(config);
    initializer.close();
    openStorages.splice(openStorages.indexOf(initializer), 1);
    const childConfig = { ...config, now: undefined };
    delete childConfig.now;

    await runConcurrentWorkers(childConfig, "198.51.100.50", 8, 4, now);
    const inspectionDb = new Database(dbPath);
    expect(inspectionDb.prepare("SELECT COUNT(*) FROM login_rate_limit_failures WHERE identity = ?").pluck().get("198.51.100.50")).toBe(32);
    inspectionDb.close();
  }, 20_000);

  it("creates one coherent block window under concurrent processes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-login-rate-limit-process-block-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "login-rate-limit.sqlite");
    const now = 2_000_000_000_000;
    const config = createConfig(dbPath, now, { maxFailures: 8, blockMs: 5_000 });
    const initializer = openStorage(config);
    initializer.close();
    openStorages.splice(openStorages.indexOf(initializer), 1);
    const childConfig = { ...config, now: undefined };
    delete childConfig.now;

    const results = await runConcurrentWorkers(childConfig, "198.51.100.51", 8, 2, now);
    const blockedUntilValues = new Set(results.filter((result) => result.blocked).map((result) => result.blockedUntil));
    expect(blockedUntilValues).toEqual(new Set([now + 5_000]));
    const inspectionDb = new Database(dbPath);
    expect(inspectionDb.prepare("SELECT blocked_until FROM login_rate_limit_entries WHERE identity = ?").pluck().get("198.51.100.51")).toBe(now + 5_000);
    expect(inspectionDb.prepare("SELECT COUNT(*) FROM login_rate_limit_failures WHERE identity = ?").pluck().get("198.51.100.51")).toBe(0);
    inspectionDb.close();
  }, 20_000);
});
