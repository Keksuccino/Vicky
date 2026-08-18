import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
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
