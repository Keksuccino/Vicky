import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import {
  ADMIN_USERNAME,
  getRequestSession,
  normalizeUsername,
  verifyAdminPassword,
  verifySessionToken,
  type AuthSession,
} from "@/lib/auth";
import { badRequest, notFound } from "@/lib/http";
import { getStore, updateStore } from "@/lib/store";
import type { ModeratorAccount } from "@/lib/types";

const MODERATOR_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PASSWORD_HASH_SCHEME = "scrypt";
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const PASSWORD_MIN_LENGTH = 8;

export type ModeratorAccountSummary = {
  id: string;
  username: string;
  createdAt: string;
  updatedAt: string;
};

type CreateModeratorInput = {
  username: string;
  password: string;
};

type UpdateModeratorInput = {
  username?: string;
  password?: string;
};

const now = (): string => new Date().toISOString();

const scryptAsync = (password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });

const toSummary = (account: ModeratorAccount): ModeratorAccountSummary => ({
  id: account.id,
  username: account.username,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

export const validateModeratorUsername = (value: string): string => {
  const username = normalizeUsername(value);

  if (username === ADMIN_USERNAME) {
    throw badRequest(`"${ADMIN_USERNAME}" is reserved for the built-in admin account.`);
  }

  if (!MODERATOR_USERNAME_PATTERN.test(username)) {
    throw badRequest("Moderator username must be 3-32 characters using letters, numbers, dots, underscores, or hyphens.");
  }

  return username;
};

const validateModeratorPassword = (value: string): string => {
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw badRequest(`Moderator password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  return value;
};

const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const derivedKey = await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: SCRYPT_MAX_MEMORY,
  });

  return [
    PASSWORD_HASH_SCHEME,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
};

const verifyPasswordHash = async (password: string, passwordHash: string): Promise<boolean> => {
  const [scheme, costRaw, blockSizeRaw, parallelizationRaw, saltRaw, hashRaw] = passwordHash.split("$");
  if (scheme !== PASSWORD_HASH_SCHEME || !costRaw || !blockSizeRaw || !parallelizationRaw || !saltRaw || !hashRaw) {
    return false;
  }

  const cost = Number.parseInt(costRaw, 10);
  const blockSize = Number.parseInt(blockSizeRaw, 10);
  const parallelization = Number.parseInt(parallelizationRaw, 10);
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) {
    return false;
  }

  try {
    const salt = Buffer.from(saltRaw, "base64url");
    const expectedHash = Buffer.from(hashRaw, "base64url");
    const candidateHash = await scryptAsync(password, salt, expectedHash.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: SCRYPT_MAX_MEMORY,
    });

    return expectedHash.length === candidateHash.length && timingSafeEqual(expectedHash, candidateHash);
  } catch {
    return false;
  }
};

export const authenticateCredentials = async (username: string, password: string): Promise<AuthSession | null> => {
  const normalizedUsername = normalizeUsername(username);

  if (normalizedUsername === ADMIN_USERNAME) {
    return (await verifyAdminPassword(password)) ? { role: "admin", username: ADMIN_USERNAME } : null;
  }

  if (!MODERATOR_USERNAME_PATTERN.test(normalizedUsername)) {
    return null;
  }

  const store = await getStore();
  const account = store.moderators.find((moderator) => moderator.username === normalizedUsername);
  if (!account) {
    return null;
  }

  return (await verifyPasswordHash(password, account.passwordHash))
    ? { role: "moderator", username: account.username }
    : null;
};

export const getActiveSession = async (session: AuthSession | null): Promise<AuthSession | null> => {
  if (!session) {
    return null;
  }

  if (session.role === "admin") {
    return session.username === ADMIN_USERNAME ? session : { role: "admin", username: ADMIN_USERNAME };
  }

  const store = await getStore();
  const account = store.moderators.find((moderator) => moderator.username === session.username);
  return account ? session : null;
};

export const getActiveSessionForToken = async (token: string): Promise<AuthSession | null> =>
  getActiveSession(await verifySessionToken(token));

export const getActiveRequestSession = async (request: NextRequest): Promise<AuthSession | null> =>
  getActiveSession(await getRequestSession(request));

export const requireEditorAccountRequest = async (request: NextRequest): Promise<NextResponse | null> => {
  const session = await getActiveRequestSession(request);

  if (session) {
    return null;
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
};

export const listModeratorAccounts = async (): Promise<ModeratorAccountSummary[]> => {
  const store = await getStore();
  return store.moderators.map(toSummary);
};

export const createModeratorAccount = async (input: CreateModeratorInput): Promise<ModeratorAccountSummary> => {
  const username = validateModeratorUsername(input.username);
  const passwordHash = await hashPassword(validateModeratorPassword(input.password));
  let createdAccount: ModeratorAccountSummary | null = null;

  await updateStore((store) => {
    if (store.moderators.some((moderator) => moderator.username === username)) {
      throw badRequest("A moderator with that username already exists.");
    }

    const timestamp = now();
    const account: ModeratorAccount = {
      id: randomUUID(),
      username,
      passwordHash,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    store.moderators.push(account);
    createdAccount = toSummary(account);
  });

  if (!createdAccount) {
    throw new Error("Moderator account was not created.");
  }

  return createdAccount;
};

export const updateModeratorAccount = async (
  id: string,
  input: UpdateModeratorInput,
): Promise<ModeratorAccountSummary> => {
  const username = input.username !== undefined ? validateModeratorUsername(input.username) : undefined;
  const passwordHash = input.password !== undefined ? await hashPassword(validateModeratorPassword(input.password)) : undefined;
  let updatedAccount: ModeratorAccountSummary | null = null;

  await updateStore((store) => {
    const account = store.moderators.find((moderator) => moderator.id === id);
    if (!account) {
      throw notFound("Moderator account not found.");
    }

    if (
      username &&
      username !== account.username &&
      store.moderators.some((moderator) => moderator.id !== id && moderator.username === username)
    ) {
      throw badRequest("A moderator with that username already exists.");
    }

    if (username) {
      account.username = username;
    }

    if (passwordHash) {
      account.passwordHash = passwordHash;
    }

    account.updatedAt = now();
    updatedAccount = toSummary(account);
  });

  if (!updatedAccount) {
    throw new Error("Moderator account was not updated.");
  }

  return updatedAccount;
};

export const deleteModeratorAccount = async (id: string): Promise<void> => {
  await updateStore((store) => {
    const nextModerators = store.moderators.filter((moderator) => moderator.id !== id);
    if (nextModerators.length === store.moderators.length) {
      throw notFound("Moderator account not found.");
    }

    store.moderators = nextModerators;
  });
};
