import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDedicatedPrivateDirectory,
  ensurePrivateDirectory,
  ensurePrivateFile,
  ensurePrivateFileSync,
  secureAtomicWriteFile,
} from "@/lib/runtime-file-security.mjs";

const tempDirs: string[] = [];
const modeOf = async (targetPath: string): Promise<number> => (await stat(targetPath)).mode & 0o777;

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
    await expect(ensurePrivateDirectory(os.tmpdir())).rejects.toThrow("dedicated runtime directory");
    await expect(ensurePrivateDirectory(path.parse(process.cwd()).root)).rejects.toThrow("dedicated runtime directory");
  });

  it("rejects a symlink alias to a broad operating-system directory", async () => {
    const tempDir = await createTempDir();
    const broadDirectory = process.platform === "darwin" ? "/Users" : "/var/lib";
    const aliasPath = path.join(tempDir, "shared-alias");
    const before = await stat(broadDirectory);
    await symlink(broadDirectory, aliasPath, "dir");

    await expect(ensurePrivateDirectory(aliasPath)).rejects.toThrow("shared, system, or root directory");
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

    await expect(ensurePrivateDirectory(broadDirectory)).rejects.toThrow("shared, system, or root directory");
    const after = await stat(broadDirectory);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(() => assertDedicatedPrivateDirectory(path.join(broadDirectory, "vicky"))).not.toThrow();
  });
});
