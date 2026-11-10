import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDedicatedPrivateDirectory,
  ensurePrivateDirectory,
  ensurePrivateDirectorySync,
  ensurePrivateFile,
  ensurePrivateFileSync,
  openPrivateFileExclusive,
  secureAtomicWriteFile,
} from "@/lib/runtime-file-security.mjs";

const tempDirs: string[] = [];
const modeOf = async (targetPath: string): Promise<number> => (await stat(targetPath)).mode & 0o777;
// chmod updates the change time even when the mode stays the same, and file watchers report it.
const changeTimeOf = async (targetPath: string): Promise<bigint> => (await stat(targetPath, { bigint: true })).ctimeNs;

const createTempDir = async (): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-runtime-security-"));
  tempDirs.push(tempDir);
  return tempDir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("runtime file security", () => {
  it("refuses to chmod shared or root directories", async () => {
    await expect(ensurePrivateDirectory(os.tmpdir())).rejects.toMatchObject({ code: "SHARED_DIRECTORY" });
    await expect(ensurePrivateDirectory(path.parse(process.cwd()).root)).rejects.toMatchObject({ code: "SHARED_DIRECTORY" });
  });

  it("rejects a symlink alias to a broad operating-system directory", async () => {
    const tempDir = await createTempDir();
    const broadDirectory = process.platform === "darwin" ? "/Users" : "/var/lib";
    const aliasPath = path.join(tempDir, "shared-alias");
    const before = await stat(broadDirectory);
    await symlink(broadDirectory, aliasPath, "dir");

    await expect(ensurePrivateDirectory(aliasPath)).rejects.toMatchObject({ code: "SHARED_DIRECTORY" });
    const after = await stat(broadDirectory);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("repairs and verifies existing directory and file permissions", async () => {
    const tempDir = await createTempDir();
    const privateDir = path.join(tempDir, "private");
    const privateFile = path.join(privateDir, "state.json");

    await ensurePrivateDirectory(privateDir);
    await writeFile(privateFile, "sensitive", { encoding: "utf8", mode: 0o644 });
    await chmod(privateDir, 0o755);
    await chmod(privateFile, 0o644);

    expect(await ensurePrivateFile(privateFile)).toBe(true);
    await expect(modeOf(privateDir)).resolves.toBe(0o700);
    await expect(modeOf(privateFile)).resolves.toBe(0o600);

    await chmod(privateFile, 0o666);
    expect(ensurePrivateFileSync(privateFile)).toBe(true);
    await expect(modeOf(privateFile)).resolves.toBe(0o600);
  });

  it("verifies already private paths without changing them", async () => {
    const tempDir = await createTempDir();
    const privateDir = path.join(tempDir, "private");
    const privateFile = path.join(privateDir, "state.json");

    await ensurePrivateDirectory(privateDir);
    await writeFile(privateFile, "sensitive", { encoding: "utf8", mode: 0o600 });
    await chmod(privateFile, 0o600);
    const directoryChangeTime = await changeTimeOf(privateDir);
    const fileChangeTime = await changeTimeOf(privateFile);

    await ensurePrivateDirectory(privateDir);
    ensurePrivateDirectorySync(privateDir);
    expect(await ensurePrivateFile(privateFile)).toBe(true);
    expect(ensurePrivateFileSync(privateFile)).toBe(true);
    expect(await ensurePrivateFile(path.join(privateDir, "missing.json"))).toBe(false);

    await expect(changeTimeOf(privateDir)).resolves.toBe(directoryChangeTime);
    await expect(changeTimeOf(privateFile)).resolves.toBe(fileChangeTime);
    expect(await readdir(privateDir)).toEqual(["state.json"]);
  });

  it("creates private directories and exclusive files with verified modes", async () => {
    const tempDir = await createTempDir();
    const nestedDir = path.join(tempDir, "nested", "private");
    const syncDir = path.join(tempDir, "sync-private");

    await ensurePrivateDirectory(nestedDir);
    ensurePrivateDirectorySync(syncDir);
    const handle = await openPrivateFileExclusive(path.join(nestedDir, "lock"));
    await handle.close();

    await expect(modeOf(nestedDir)).resolves.toBe(0o700);
    await expect(modeOf(syncDir)).resolves.toBe(0o700);
    await expect(modeOf(path.join(nestedDir, "lock"))).resolves.toBe(0o600);
  });

  it("clears special mode bits that a repairing chmod clears", async () => {
    const tempDir = await createTempDir();
    const privateFile = path.join(tempDir, "state.json");
    await writeFile(privateFile, "sensitive", { encoding: "utf8", mode: 0o600 });

    await chmod(privateFile, 0o4600);
    expect(await ensurePrivateFile(privateFile)).toBe(true);
    expect((await stat(privateFile)).mode & 0o7777).toBe(0o600);

    await chmod(privateFile, 0o4600);
    expect(ensurePrivateFileSync(privateFile)).toBe(true);
    expect((await stat(privateFile)).mode & 0o7777).toBe(0o600);
  });

  it("fails closed for a path of the wrong type without changing its permissions", async () => {
    const tempDir = await createTempDir();
    const directoryAtFilePath = path.join(tempDir, "state.json");
    const fileAtDirectoryPath = path.join(tempDir, "cache");
    await ensurePrivateDirectory(directoryAtFilePath);
    await writeFile(fileAtDirectoryPath, "", { encoding: "utf8", mode: 0o600 });

    await expect(ensurePrivateFile(directoryAtFilePath)).rejects.toThrow();
    expect(() => ensurePrivateFileSync(directoryAtFilePath)).toThrow();
    await expect(ensurePrivateDirectory(fileAtDirectoryPath)).rejects.toThrow();
    expect(() => ensurePrivateDirectorySync(fileAtDirectoryPath)).toThrow();
    await expect(modeOf(directoryAtFilePath)).resolves.toBe(0o700);
  });

  it("atomically replaces an existing file without leaving permissive or temporary files", async () => {
    const tempDir = await createTempDir();
    const privateDir = path.join(tempDir, "private");
    const privateFile = path.join(privateDir, "state.json");

    await ensurePrivateDirectory(privateDir);
    await writeFile(privateFile, "old", { encoding: "utf8", mode: 0o644 });
    await chmod(privateDir, 0o755);
    await secureAtomicWriteFile(privateFile, "new", "utf8");

    expect(await readFile(privateFile, "utf8")).toBe("new");
    expect(await readdir(privateDir)).toEqual(["state.json"]);
    await expect(modeOf(privateDir)).resolves.toBe(0o700);
    await expect(modeOf(privateFile)).resolves.toBe(0o600);
  });
});

describe("runtime directory classification", () => {
  it("rejects broad operating-system directories without changing them and permits dedicated children", async () => {
    const broadDirectory = process.platform === "win32" ? path.dirname(os.homedir()) : process.platform === "darwin" ? "/Users" : "/var/lib";
    const before = await stat(broadDirectory);

    await expect(ensurePrivateDirectory(broadDirectory)).rejects.toMatchObject({ code: "SHARED_DIRECTORY" });
    const after = await stat(broadDirectory);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(() => assertDedicatedPrivateDirectory(path.join(broadDirectory, "vicky"))).not.toThrow();
  });
});
