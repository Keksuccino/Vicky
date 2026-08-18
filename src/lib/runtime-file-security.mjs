import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const PERMISSION_BITS = 0o777;
const SUPPORTS_POSIX_PERMISSIONS = process.platform !== "win32";
const PROTECTED_PRIVATE_DIRECTORIES = new Set([path.resolve(os.tmpdir()), path.resolve(os.homedir()), path.resolve(/*turbopackIgnore: true*/ process.cwd())]);

const assertDedicatedPrivateDirectory = (directoryPath) => {
  const resolvedPath = path.resolve(directoryPath);
  if (resolvedPath === path.parse(resolvedPath).root || PROTECTED_PRIVATE_DIRECTORIES.has(resolvedPath)) {
    throw new Error(`Refusing to change permissions on shared or root directory ${resolvedPath}; configure a dedicated runtime directory.`);
  }
};

const isMissingPathError = (error) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const unexpectedModeError = (targetPath, expectedMode, actualMode) => {
  const error = new Error(`Failed to secure runtime path ${targetPath}: expected mode ${expectedMode.toString(8)}, found ${actualMode.toString(8)}.`);
  error.code = "EACCES";
  return error;
};

const verifyMode = (targetPath, expectedMode, actualMode) => {
  const permissionMode = actualMode & PERMISSION_BITS;
  if (permissionMode !== expectedMode) {
    throw unexpectedModeError(targetPath, expectedMode, permissionMode);
  }
};

/**
 * Creates a private runtime directory and repairs permissions when it already exists.
 * Windows does not implement POSIX mode bits; on that platform the containing volume's
 * ACL remains authoritative, while POSIX hosts fail closed when chmod cannot be verified.
 *
 * @param {string} directoryPath
 * @returns {Promise<void>}
 */
export async function ensurePrivateDirectory(directoryPath) {
  assertDedicatedPrivateDirectory(directoryPath);
  await mkdir(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!SUPPORTS_POSIX_PERMISSIONS) {
    return;
  }

  await chmod(directoryPath, PRIVATE_DIRECTORY_MODE);
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Private runtime directory path is not a directory: ${directoryPath}`);
  }
  verifyMode(directoryPath, PRIVATE_DIRECTORY_MODE, directoryStat.mode);
}

/**
 * Synchronous counterpart used before native libraries open runtime files.
 *
 * @param {string} directoryPath
 * @returns {void}
 */
export function ensurePrivateDirectorySync(directoryPath) {
  assertDedicatedPrivateDirectory(directoryPath);
  mkdirSync(directoryPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!SUPPORTS_POSIX_PERMISSIONS) {
    return;
  }

  chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE);
  const directoryStat = statSync(directoryPath);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Private runtime directory path is not a directory: ${directoryPath}`);
  }
  verifyMode(directoryPath, PRIVATE_DIRECTORY_MODE, directoryStat.mode);
}

/**
 * Repairs and verifies a sensitive file before it is opened. Missing files are valid
 * because callers commonly use this during startup before the first persisted write.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>} Whether the file exists.
 */
export async function ensurePrivateFile(filePath) {
  await ensurePrivateDirectory(path.dirname(filePath));

  try {
    if (SUPPORTS_POSIX_PERMISSIONS) {
      await chmod(filePath, PRIVATE_FILE_MODE);
    }
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`Private runtime file path is not a regular file: ${filePath}`);
    }
    if (SUPPORTS_POSIX_PERMISSIONS) {
      verifyMode(filePath, PRIVATE_FILE_MODE, fileStat.mode);
    }
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Synchronous counterpart used for SQLite and synchronous cache reads.
 *
 * @param {string} filePath
 * @returns {boolean} Whether the file exists.
 */
export function ensurePrivateFileSync(filePath) {
  ensurePrivateDirectorySync(path.dirname(filePath));

  try {
    if (SUPPORTS_POSIX_PERMISSIONS) {
      chmodSync(filePath, PRIVATE_FILE_MODE);
    }
    const fileStat = statSync(filePath);
    if (!fileStat.isFile()) {
      throw new Error(`Private runtime file path is not a regular file: ${filePath}`);
    }
    if (SUPPORTS_POSIX_PERMISSIONS) {
      verifyMode(filePath, PRIVATE_FILE_MODE, fileStat.mode);
    }
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Opens a newly-created private file without a window in which umask-derived permissions
 * are observable. The descriptor mode is enforced again because mode-on-create does not
 * repair an existing file and is not honored consistently by every filesystem.
 *
 * @param {string} filePath
 * @returns {Promise<import("node:fs/promises").FileHandle>}
 */
export async function openPrivateFileExclusive(filePath) {
  await ensurePrivateDirectory(path.dirname(filePath));
  const handle = await open(filePath, "wx", PRIVATE_FILE_MODE);

  try {
    if (SUPPORTS_POSIX_PERMISSIONS) {
      await handle.chmod(PRIVATE_FILE_MODE);
      const handleStat = await handle.stat();
      verifyMode(filePath, PRIVATE_FILE_MODE, handleStat.mode);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Atomically replaces a sensitive file with a same-directory temporary file. Keeping the
 * temporary file beside the destination is important: rename remains atomic and cannot
 * cross filesystem boundaries. Failed writes remove only their uniquely named temp file.
 *
 * @param {string} filePath
 * @param {string | NodeJS.ArrayBufferView} data
 * @param {BufferEncoding | null} [encoding]
 * @returns {Promise<void>}
 */
export async function secureAtomicWriteFile(filePath, data, encoding = null) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle;

  try {
    handle = await openPrivateFileExclusive(tempPath);
    await handle.writeFile(data, encoding ? { encoding } : undefined);
    await handle.close();
    handle = undefined;
    await ensurePrivateFile(tempPath);
    await rename(tempPath, filePath);
    await ensurePrivateFile(filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
