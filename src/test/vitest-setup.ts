import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";

import { afterEach, inject } from "vitest";

import { findRuntimePathsInDataDirectory } from "./runtime-data-guard.mjs";

/**
 * Runs before every test file (Vitest `setupFiles`):
 *
 * - Every runtime path defaults into a directory of this test file inside the run's directory
 *   (see vitest-global-setup.ts), so nothing a test, a module default, or a background job that
 *   outlives its test writes can reach the project's real `data/`. A test that leaves a path
 *   pointing into `data/` (for example by deleting the variable) fails, and the defaults are
 *   restored for the tests after it.
 * - No test can reach the network: `fetch` to a host other than loopback is rejected at once, and
 *   every other TCP connection to such a host fails as refused. Either attempt fails the test,
 *   even when the code under test swallowed the error.
 * - Components rendered with Testing Library are unmounted after each test. Its automatic cleanup
 *   needs Vitest globals, which this project keeps off.
 */

const RUNTIME_PATH_DEFAULTS: Record<string, string> = {
  AUTH_LOGIN_DB_PATH: "login/login-rate-limit.sqlite",
  AUTH_LOGIN_STORE_FILE_PATH: "login/login-rate-limit.json",
  SSL_STATUS_FILE_PATH: "ssl/runtime-ssl-status.json",
  WIKI_ANALYTICS_DB_PATH: "analytics/wiki-analytics.sqlite",
  WIKI_DOCS_CACHE_DIR: "docs-cache",
  WIKI_MARKDOWN_CACHE_DIR: "markdown-cache",
  WIKI_SSL_STORAGE_DIR: "ssl",
  WIKI_STORE_FILE_PATH: "store/wiki-store.json",
  WIKI_TRANSLATION_CACHE_DIR: "translation-cache",
};

const testFileRuntimeDir = path.join(inject("vickyTestRuntimeDir"), randomUUID());

const applyRuntimePathDefaults = (): void => {
  for (const [name, relativePath] of Object.entries(RUNTIME_PATH_DEFAULTS)) {
    process.env[name] = path.join(testFileRuntimeDir, relativePath);
  }
};

applyRuntimePathDefaults();

const blockedConnections: string[] = [];

const isLoopbackHost = (host: string | undefined): boolean => {
  const normalized = (host ?? "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return !normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1" || normalized === "0.0.0.0" || normalized === "::" || /^(::ffff:)?127\.\d+\.\d+\.\d+$/.test(normalized);
};

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, globalThis.location?.href ?? "http://localhost/");
  if ((url.protocol === "http:" || url.protocol === "https:") && !isLoopbackHost(url.hostname)) {
    blockedConnections.push(url.origin);
    return Promise.reject(new TypeError(`Tests must not reach the network: fetch to ${url.origin} was blocked. Stub fetch for this test.`));
  }
  return realFetch(input, init);
}) as typeof fetch;

/** `host:port` of a connection `net.Socket#connect` would open to a non-loopback host, or null. */
const nonLoopbackTarget = (args: unknown[]): string | null => {
  // net.connect() and tls.connect() pass their already normalized `[options, callback]` array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    const options = first as { host?: unknown; path?: unknown; port?: unknown };
    if (typeof options.path === "string") {
      return null;
    }
    const host = typeof options.host === "string" ? options.host : undefined;
    return isLoopbackHost(host) ? null : `${host}:${String(options.port)}`;
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) {
    return null;
  }
  const host = typeof args[1] === "string" ? args[1] : undefined;
  return isLoopbackHost(host) ? null : `${host}:${String(first)}`;
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const target = nonLoopbackTarget(args);
  if (!target) {
    return Reflect.apply(realConnect, this, args) as net.Socket;
  }

  blockedConnections.push(target);
  const error = Object.assign(new Error(`Tests must not reach the network: a connection to ${target} was blocked.`), { code: "ECONNREFUSED" });
  process.nextTick(() => this.destroy(error));
  return this;
} as typeof realConnect;

if (typeof document !== "undefined") {
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => {
    cleanup();
  });
}

afterEach(() => {
  const problems: string[] = [];
  const blocked = blockedConnections.splice(0);
  if (blocked.length > 0) {
    problems.push(`it tried to reach the network (${[...new Set(blocked)].join(", ")})`);
  }
  const pathsInData = findRuntimePathsInDataDirectory();
  if (pathsInData.length > 0) {
    applyRuntimePathDefaults();
    problems.push(`it left runtime paths pointing into data/ (${pathsInData.join(", ")}); restore the previous values instead of deleting them`);
  }
  if (problems.length > 0) {
    throw new Error(`Test safety check failed: ${problems.join("; ")}.`);
  }
});
