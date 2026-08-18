import { randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync, rmSync } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assertDedicatedPrivateDirectory, ensurePrivateDirectory, ensurePrivateFile, openPrivateFileExclusive, secureAtomicWriteFile } from "./runtime-file-security.mjs";

export const SUPPORTED_RUNTIME_TOPOLOGY = "single-process-local";
export const RUNTIME_TOPOLOGY_ENV = "VICKY_RUNTIME_TOPOLOGY";
export const RUNTIME_OWNER_ID_ENV = "VICKY_INTERNAL_RUNTIME_OWNER_ID";

const OWNER_SCHEMA_VERSION = 1;
const OWNER_FILE_SUFFIX = ".runtime-owner.json";
const OWNER_STATE_KEY = Symbol.for("vicky.runtimeTopology.ownerLease");
const OWNER_ASSIGNMENT_POLL_MS = 10;
const OWNER_ASSIGNMENT_TIMEOUT_MS = 10_000;

const defaultPath = (cwd, ...segments) => path.join(cwd, ...segments);
const configuredPath = (value, fallback, cwd, variableName) => {
  if (value !== undefined && !String(value).trim()) {
    throw new RuntimeTopologyError(`${variableName} must not be empty when configured.`);
  }
  return path.resolve(cwd, value ?? fallback);
};
const configuredTrimmedPath = (value, fallback, cwd, variableName) => {
  if (value !== undefined && !String(value).trim()) {
    throw new RuntimeTopologyError(`${variableName} must not be empty when configured.`);
  }
  return path.resolve(cwd, value?.trim() || fallback);
};
const isMissingPathError = (error) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

export class RuntimeTopologyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeTopologyError";
  }
}

export function validateRuntimeTopology(environment = process.env) {
  const configured = String(environment[RUNTIME_TOPOLOGY_ENV] ?? "").trim();
  if (configured === SUPPORTED_RUNTIME_TOPOLOGY) {
    return SUPPORTED_RUNTIME_TOPOLOGY;
  }

  const received = configured ? ` Received ${JSON.stringify(configured)}.` : "";
  throw new RuntimeTopologyError(`${RUNTIME_TOPOLOGY_ENV} must be set to ${JSON.stringify(SUPPORTED_RUNTIME_TOPOLOGY)}.${received} Vicky does not provide multi-process or multi-host coordination.`);
}

export function resolveRuntimeStorageLayout(environment = process.env, cwd = process.cwd()) {
  const storePath = configuredPath(environment.WIKI_STORE_FILE_PATH, defaultPath(cwd, "data", "wiki-store.json"), cwd, "WIKI_STORE_FILE_PATH");
  const sslStorageDir = configuredPath(environment.WIKI_SSL_STORAGE_DIR, defaultPath(cwd, "data", "ssl"), cwd, "WIKI_SSL_STORAGE_DIR");
  const sslStatusPath = configuredPath(environment.SSL_STATUS_FILE_PATH, path.join(sslStorageDir, "runtime-ssl-status.json"), cwd, "SSL_STATUS_FILE_PATH");
  const analyticsDbPath = configuredTrimmedPath(environment.WIKI_ANALYTICS_DB_PATH, defaultPath(cwd, "data", "wiki-analytics.sqlite"), cwd, "WIKI_ANALYTICS_DB_PATH");
  const legacyLoginPath = configuredTrimmedPath(environment.AUTH_LOGIN_STORE_FILE_PATH, defaultPath(cwd, "data", "login-rate-limit.json"), cwd, "AUTH_LOGIN_STORE_FILE_PATH");
  const derivedLoginDbPath = legacyLoginPath.toLowerCase().endsWith(".json") ? `${legacyLoginPath.slice(0, -5)}.sqlite` : `${legacyLoginPath}.sqlite`;
  const loginDbPath = configuredTrimmedPath(environment.AUTH_LOGIN_DB_PATH, environment.AUTH_LOGIN_STORE_FILE_PATH ? derivedLoginDbPath : defaultPath(cwd, "data", "login-rate-limit.sqlite"), cwd, "AUTH_LOGIN_DB_PATH");
  const directories = [
    path.dirname(storePath),
    sslStorageDir,
    path.dirname(sslStatusPath),
    configuredTrimmedPath(environment.WIKI_MARKDOWN_CACHE_DIR, defaultPath(cwd, "data", "markdown-cache"), cwd, "WIKI_MARKDOWN_CACHE_DIR"),
    configuredTrimmedPath(environment.WIKI_DOCS_SNAPSHOT_DIR, defaultPath(cwd, "data", "docs-cache", "snapshots"), cwd, "WIKI_DOCS_SNAPSHOT_DIR"),
    configuredTrimmedPath(environment.WIKI_TRANSLATION_CACHE_DIR, defaultPath(cwd, "data", "translation-cache"), cwd, "WIKI_TRANSLATION_CACHE_DIR"),
    path.dirname(analyticsDbPath),
    path.dirname(loginDbPath),
    path.dirname(legacyLoginPath),
  ];
  const sensitiveFiles = [
    storePath,
    sslStatusPath,
    analyticsDbPath,
    `${analyticsDbPath}-wal`,
    `${analyticsDbPath}-shm`,
    `${analyticsDbPath}-journal`,
    loginDbPath,
    `${loginDbPath}-wal`,
    `${loginDbPath}-shm`,
    `${loginDbPath}-journal`,
    legacyLoginPath,
  ];

  return {
    directories: [...new Set(directories)],
    ownerFilePath: `${storePath}${OWNER_FILE_SUFFIX}`,
    sensitiveFiles: [...new Set(sensitiveFiles)],
    storePath,
  };
}

const parseOwnerRecord = (raw) => {
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value) || value.schemaVersion !== OWNER_SCHEMA_VERSION || value.topology !== SUPPORTED_RUNTIME_TOPOLOGY || typeof value.ownerId !== "string" || !value.ownerId.trim() || typeof value.hostname !== "string" || !value.hostname.trim() || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
};

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

const ownerDescription = (owner) => owner ? `${owner.hostname} pid ${owner.pid}, started ${owner.startedAt}` : "an unreadable owner record";
const wait = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const removeOwnerFileIfUnchanged = async (filePath, expectedRaw) => {
  let currentRaw;
  try {
    currentRaw = await readFile(/*turbopackIgnore: true*/ filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }

  if (currentRaw !== expectedRaw) {
    return false;
  }
  await rm(filePath);
  return true;
};

const removeOwnerFileIfOwned = async (filePath, ownerId) => {
  let raw;
  try {
    raw = await readFile(/*turbopackIgnore: true*/ filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  if (parseOwnerRecord(raw)?.ownerId === ownerId) {
    await rm(filePath);
  }
};

const writeOwnerRecordExclusive = async (filePath, record) => {
  const handle = await openPrivateFileExclusive(filePath);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
};

const verifyPrivateDirectoryWritable = async (directoryPath) => {
  const probePath = path.join(directoryPath, `.vicky-runtime-preflight-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await openPrivateFileExclusive(probePath);
    await handle.close();
    handle = undefined;
    await rm(probePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(probePath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const preflightRuntimeStorage = async (layout) => {
  for (const directoryPath of layout.directories) {
    await ensurePrivateDirectory(directoryPath);
    await verifyPrivateDirectoryWritable(directoryPath);
  }
  for (const filePath of layout.sensitiveFiles) {
    if (await ensurePrivateFile(filePath)) {
      await access(filePath, fsConstants.W_OK);
    }
  }
};

const assertRuntimeStorageLayoutIsDedicated = (layout) => {
  // Validate the complete layout before acquiring the owner file. A later cache or
  // database path must not discover /var/lib (or another shared directory) only after
  // an earlier path has already been created or chmodded.
  for (const directoryPath of layout.directories) {
    assertDedicatedPrivateDirectory(directoryPath);
  }
};

const getOwnerState = () => {
  const globalState = globalThis;
  return globalState[OWNER_STATE_KEY] ?? null;
};

const setOwnerState = (state) => {
  const globalState = globalThis;
  if (state) {
    globalState[OWNER_STATE_KEY] = state;
  } else {
    delete globalState[OWNER_STATE_KEY];
  }
};

export function shouldReleaseRuntimeOwnerOnProcessExit(rawOwner, ownerId, exitingPid = process.pid) {
  const owner = parseOwnerRecord(rawOwner);
  return Boolean(owner && owner.ownerId === ownerId && owner.pid === exitingPid);
}

export async function acquireRuntimeOwnerLease(options = {}) {
  const environment = options.environment ?? process.env;
  validateRuntimeTopology(environment);

  if (getOwnerState()) {
    throw new RuntimeTopologyError("This process already owns a Vicky runtime lease.");
  }

  const cwd = options.cwd ?? process.cwd();
  const hostname = options.hostname ?? os.hostname();
  const initialPid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? processIsAlive;
  const layout = resolveRuntimeStorageLayout(environment, cwd);
  assertRuntimeStorageLayoutIsDedicated(layout);
  await ensurePrivateDirectory(path.dirname(layout.ownerFilePath));

  let record = {
    schemaVersion: OWNER_SCHEMA_VERSION,
    topology: SUPPORTED_RUNTIME_TOPOLOGY,
    ownerId: randomUUID(),
    hostname,
    pid: initialPid,
    startedAt: new Date().toISOString(),
  };

  for (;;) {
    try {
      await writeOwnerRecordExclusive(layout.ownerFilePath, record);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      await ensurePrivateFile(layout.ownerFilePath);
      const raw = await readFile(/*turbopackIgnore: true*/ layout.ownerFilePath, "utf8");
      const owner = parseOwnerRecord(raw);
      if (owner && owner.hostname === hostname && !isAlive(owner.pid)) {
        if (await removeOwnerFileIfUnchanged(layout.ownerFilePath, raw)) {
          continue;
        }
        continue;
      }

      throw new RuntimeTopologyError(`Refusing to start because ${layout.ownerFilePath} is held by ${ownerDescription(owner)}. Vicky supports exactly one application process on one local runtime volume. If that owner no longer exists on a different host, verify it is stopped before removing the owner file manually.`);
    }
  }

  let released = false;
  const releaseSync = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      const rawOwner = readFileSync(/*turbopackIgnore: true*/ layout.ownerFilePath, "utf8");
      if (shouldReleaseRuntimeOwnerOnProcessExit(rawOwner, record.ownerId)) {
        rmSync(layout.ownerFilePath);
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        console.error(`[vicky] Failed to release runtime owner file ${layout.ownerFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setOwnerState(null);
  };
  process.once("exit", releaseSync);

  const lease = {
    id: record.ownerId,
    ownerFilePath: layout.ownerFilePath,
    async assignProcess(pid) {
      if (released) {
        throw new RuntimeTopologyError("Cannot assign a released Vicky runtime lease.");
      }
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new TypeError("Runtime owner PID must be a positive integer.");
      }
      const nextRecord = { ...record, pid };
      const nextRawRecord = `${JSON.stringify(nextRecord, null, 2)}\n`;
      await secureAtomicWriteFile(layout.ownerFilePath, nextRawRecord, "utf8");
      record = nextRecord;
    },
    async release() {
      if (released) {
        return;
      }
      process.removeListener("exit", releaseSync);
      released = true;
      await removeOwnerFileIfOwned(layout.ownerFilePath, record.ownerId);
      setOwnerState(null);
    },
  };

  setOwnerState(lease);
  environment[RUNTIME_OWNER_ID_ENV] = lease.id;
  try {
    await preflightRuntimeStorage(layout);
    return lease;
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
}

export async function verifyInheritedRuntimeOwnerLease(environment = process.env, cwd = process.cwd()) {
  validateRuntimeTopology(environment);
  const expectedOwnerId = String(environment[RUNTIME_OWNER_ID_ENV] ?? "").trim();
  if (!expectedOwnerId) {
    throw new RuntimeTopologyError("No runtime owner lease was inherited. Start Vicky through npm run dev, npm run start, or npm run start:next.");
  }

  const { ownerFilePath } = resolveRuntimeStorageLayout(environment, cwd);
  await ensurePrivateFile(ownerFilePath);
  let raw;
  try {
    raw = await readFile(/*turbopackIgnore: true*/ ownerFilePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new RuntimeTopologyError(`The inherited runtime owner file is missing: ${ownerFilePath}`);
    }
    throw error;
  }

  const owner = parseOwnerRecord(raw);
  if (!owner || owner.ownerId !== expectedOwnerId) {
    throw new RuntimeTopologyError(`The inherited runtime owner lease does not match ${ownerFilePath}. Refusing to start without exclusive runtime ownership.`);
  }
}

/**
 * The spawned child calls this before importing Next.js. That gate is important: until
 * the parent atomically records the child PID, a parent SIGKILL could otherwise leave a
 * live unrecorded server that a replacement process might mistake for a stale owner.
 */
export async function waitForRuntimeOwnerAssignment(environment = process.env, cwd = process.cwd(), pid = process.pid, options = {}) {
  validateRuntimeTopology(environment);
  const expectedOwnerId = String(environment[RUNTIME_OWNER_ID_ENV] ?? "").trim();
  if (!expectedOwnerId) {
    throw new RuntimeTopologyError("No runtime owner lease was inherited. Start Vicky through a supported npm launcher.");
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("Runtime owner PID must be a positive integer.");
  }

  const pollMs = Math.max(1, Math.floor(options.pollMs ?? OWNER_ASSIGNMENT_POLL_MS));
  const timeoutMs = Math.max(pollMs, Math.floor(options.timeoutMs ?? OWNER_ASSIGNMENT_TIMEOUT_MS));
  const deadline = Date.now() + timeoutMs;
  const { ownerFilePath } = resolveRuntimeStorageLayout(environment, cwd);

  for (;;) {
    let raw;
    try {
      raw = await readFile(/*turbopackIgnore: true*/ ownerFilePath, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new RuntimeTopologyError(`The runtime owner file disappeared before child handoff: ${ownerFilePath}`);
      }
      throw error;
    }

    const owner = parseOwnerRecord(raw);
    if (!owner || owner.ownerId !== expectedOwnerId) {
      throw new RuntimeTopologyError(`Runtime ownership changed before child handoff at ${ownerFilePath}.`);
    }
    if (owner.pid === pid) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new RuntimeTopologyError(`Timed out waiting for runtime ownership to transfer from PID ${owner.pid} to child PID ${pid}.`);
    }
    await wait(pollMs);
  }
}

export async function verifyInheritedRuntimeOwnerLeaseOrExit() {
  try {
    await verifyInheritedRuntimeOwnerLease();
  } catch (error) {
    const message = error instanceof RuntimeTopologyError ? error.message : "Runtime topology validation failed unexpectedly.";
    console.error(`[vicky] ${message}`);
    process.exit(1);
  }
}
