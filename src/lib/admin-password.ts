import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

import { getRuntimeSecret } from "@/lib/runtime-secrets.mjs";

// These parameters are one of OWASP's equivalent minimum scrypt profiles: roughly
// 32 MiB per active derivation with extra CPU work from p=3. maxmem deliberately has
// headroom above Node's approximate 128 * N * r requirement. Re-benchmark and review
// the profile as a unit before changing any value.
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 3;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SCRYPT_SALT_LENGTH = 16;
// Keep memory-hard work below the default libuv worker count and bound retained request
// strings during bursts. Eight waiters also matches the default failed-login threshold.
const MAX_CONCURRENT_DERIVATIONS = 2;
const MAX_QUEUED_DERIVATIONS = 8;

export const ADMIN_PASSWORD_BUSY_RETRY_AFTER_SECONDS = 1;

const SCRYPT_OPTIONS: ScryptOptions = Object.freeze({ N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION, maxmem: SCRYPT_MAX_MEMORY });

// The configured password is plaintext runtime input rather than a persisted hash, so a
// fresh process-local salt provides uniqueness without introducing a new state file.
const processSalt = randomBytes(SCRYPT_SALT_LENGTH);
const pendingDerivations: Array<() => void> = [];
let activeDerivations = 0;
let expectedPasswordKeyPromise: Promise<Buffer> | null = null;

export class AdminPasswordVerificationBusyError extends Error {
  constructor() {
    super("Admin password verification capacity is temporarily exhausted.");
    this.name = "AdminPasswordVerificationBusyError";
  }
}

const acquireDerivationPermit = async (): Promise<void> => {
  if (activeDerivations < MAX_CONCURRENT_DERIVATIONS) {
    activeDerivations += 1;
    return;
  }

  if (pendingDerivations.length >= MAX_QUEUED_DERIVATIONS) {
    throw new AdminPasswordVerificationBusyError();
  }

  await new Promise<void>((resolve) => pendingDerivations.push(resolve));
};

const releaseDerivationPermit = (): void => {
  const next = pendingDerivations.shift();
  if (next) {
    // The active permit is handed directly to the next waiter, so the counter must
    // remain unchanged until the queue is empty.
    next();
    return;
  }

  activeDerivations -= 1;
};

const scryptAsync = (password: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, processSalt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });

const derivePasswordKey = async (password: string): Promise<Buffer> => {
  let passwordBytes: Buffer | null = null;
  let permitAcquired = false;

  try {
    await acquireDerivationPermit();
    permitAcquired = true;
    // Only active work receives a second, mutable password copy. Queued work retains
    // the request's existing string but cannot amplify it into an unbounded Buffer queue.
    passwordBytes = Buffer.from(password, "utf8");
    return await scryptAsync(passwordBytes);
  } finally {
    passwordBytes?.fill(0);
    if (permitAcquired) {
      releaseDerivationPermit();
    }
  }
};

const getExpectedPasswordKey = (): Promise<Buffer> => {
  if (expectedPasswordKeyPromise) {
    return expectedPasswordKeyPromise;
  }

  const expectedPassword = getRuntimeSecret("ADMIN_PASSWORD");
  const pendingKey = derivePasswordKey(expectedPassword);
  expectedPasswordKeyPromise = pendingKey;
  void pendingKey.catch(() => {
    if (expectedPasswordKeyPromise === pendingKey) {
      expectedPasswordKeyPromise = null;
    }
  });

  return pendingKey;
};

/**
 * Verifies the configured built-in administrator password with an asynchronous,
 * memory-hard KDF. The process-local salt prevents precomputation, while caching only
 * the derived expected key avoids retaining another plaintext copy or repeating half
 * of the expensive work on every login.
 */
export const verifyAdminPassword = async (candidate: string): Promise<boolean> => {
  const pendingExpectedKey = getExpectedPasswordKey();
  const candidateKey = await derivePasswordKey(candidate);

  try {
    const expectedKey = await pendingExpectedKey;
    return timingSafeEqual(candidateKey, expectedKey);
  } finally {
    candidateKey.fill(0);
  }
};
