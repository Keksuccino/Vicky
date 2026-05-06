import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_STORE } from "@/lib/defaults";

const tempDirs: string[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const createStorePath = async (): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-store-test-"));
  tempDirs.push(tempDir);
  return path.join(tempDir, "wiki-store.json");
};

const writeStore = async (storePath: string, siteTitle: string): Promise<void> => {
  const store = DEFAULT_STORE();
  store.settings.siteTitle = siteTitle;
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
};

const importStore = async (storePath: string): Promise<typeof import("@/lib/store")> => {
  vi.resetModules();
  process.env.WIKI_STORE_FILE_PATH = storePath;
  return import("@/lib/store");
};

afterEach(async () => {
  delete process.env.WIKI_STORE_FILE_PATH;
  vi.resetModules();

  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("store reads", () => {
  it("does not wait on the write lock for ordinary reads", async () => {
    const storePath = await createStorePath();
    await writeStore(storePath, "Unlocked");
    await writeFile(`${storePath}.lock`, `${process.pid}:${Date.now()}`, "utf8");

    const { getStore } = await importStore(storePath);
    const read = getStore().then((store) => store.settings.siteTitle);

    try {
      const result = await Promise.race([read, sleep(100).then(() => "timed-out")]);
      expect(result).toBe("Unlocked");
    } finally {
      await rm(`${storePath}.lock`, { force: true });
      await read.catch(() => undefined);
    }
  });

  it("returns cloned values from the short read cache", async () => {
    const storePath = await createStorePath();
    await writeStore(storePath, "Cached");

    const { getStore } = await importStore(storePath);
    const first = await getStore();
    first.settings.siteTitle = "Mutated";

    const second = await getStore();
    expect(second.settings.siteTitle).toBe("Cached");
  });
});
