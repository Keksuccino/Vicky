import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_STORE } from "@/lib/defaults";
import { gitHubDocsLogicalSourceKey, legacyGitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { listPersistentRenderedMarkdownCacheEntries, writePersistentRenderedMarkdown } from "@/lib/markdown-render-cache-store";
import { readPersistentTranslatedPage, writePersistentTranslatedPage } from "@/lib/translation-cache-store";
import type { GitHubRuntimeConfig } from "@/lib/types";

const tempDirs: string[] = [];
const previousMarkdownCacheDir = process.env.WIKI_MARKDOWN_CACHE_DIR;
const previousSnapshotCacheDir = process.env.WIKI_DOCS_SNAPSHOT_DIR;
const previousTranslationCacheDir = process.env.WIKI_TRANSLATION_CACHE_DIR;

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
  if (previousMarkdownCacheDir === undefined) {
    delete process.env.WIKI_MARKDOWN_CACHE_DIR;
  } else {
    process.env.WIKI_MARKDOWN_CACHE_DIR = previousMarkdownCacheDir;
  }
  if (previousSnapshotCacheDir === undefined) {
    delete process.env.WIKI_DOCS_SNAPSHOT_DIR;
  } else {
    process.env.WIKI_DOCS_SNAPSHOT_DIR = previousSnapshotCacheDir;
  }
  if (previousTranslationCacheDir === undefined) {
    delete process.env.WIKI_TRANSLATION_CACHE_DIR;
  } else {
    process.env.WIKI_TRANSLATION_CACHE_DIR = previousTranslationCacheDir;
  }
  vi.resetModules();

  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("store reads", () => {
  it("migrates legacy stores to a unique epoch and removes only their pre-v12 snapshot", async () => {
    const storePath = await createStorePath();
    const legacyStore = DEFAULT_STORE() as unknown as Record<string, unknown>;
    const settings = legacyStore.settings as Record<string, unknown>;
    const github = settings.github as Record<string, unknown>;
    github.owner = "LegacyOwner";
    github.repo = "PrivateDocs";
    github.branch = "main";
    github.docsPath = "docs";
    delete github.cacheEpoch;
    legacyStore.version = 11;
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, JSON.stringify(legacyStore, null, 2), "utf8");

    const snapshotDir = path.join(path.dirname(storePath), "snapshots");
    const legacyConfig: GitHubRuntimeConfig = { branch: "main", docsPath: "docs", owner: "LegacyOwner", repo: "PrivateDocs", token: "" };
    const otherConfig: GitHubRuntimeConfig = { ...legacyConfig, repo: "OtherDocs" };
    const snapshotPath = (config: GitHubRuntimeConfig): string => {
      const hash = createHash("sha256").update(gitHubDocsLogicalSourceKey(config)).digest("hex");
      return path.join(snapshotDir, `${hash}.json`);
    };
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(snapshotPath(legacyConfig), "legacy private snapshot", "utf8");
    await writeFile(snapshotPath(otherConfig), "unrelated snapshot", "utf8");
    process.env.WIKI_DOCS_SNAPSHOT_DIR = snapshotDir;
    process.env.WIKI_MARKDOWN_CACHE_DIR = path.join(path.dirname(storePath), "rendered");
    process.env.WIKI_TRANSLATION_CACHE_DIR = path.join(path.dirname(storePath), "translations");
    const legacyPrefix = `${legacyGitHubRuntimeCacheKey(legacyConfig)}|`;
    const otherPrefix = `${legacyGitHubRuntimeCacheKey(otherConfig)}|`;
    const legacyRenderKey = `${legacyPrefix}markdown-render|v1|private|en-us|legacy`;
    const otherRenderKey = `${otherPrefix}markdown-render|v1|public|en-us|other`;
    const legacyTranslationKey = `${legacyPrefix}auto-translate|page|language|private|legacy`;
    const otherTranslationKey = `${otherPrefix}auto-translate|page|language|public|other`;
    const translatedPage = { content: "translated", description: "", headings: [], includeInPlaintextExport: true, markdown: "translated", path: "private.md", sha: "sha", slug: "private", title: "Private" };
    await writePersistentRenderedMarkdown(legacyRenderKey, { headings: [], html: "legacy private" });
    await writePersistentRenderedMarkdown(otherRenderKey, { headings: [], html: "other source" });
    await writePersistentTranslatedPage(legacyTranslationKey, translatedPage);
    await writePersistentTranslatedPage(otherTranslationKey, translatedPage);

    const { getStore } = await importStore(storePath);
    const normalized = await getStore();

    expect(normalized.version).toBe(12);
    expect(normalized.settings.github.cacheEpoch).toMatch(/^[0-9a-f-]{36}$/i);
    expect(normalized.settings.github.cacheEpoch).not.toBe("initial");
    const persisted = JSON.parse(await readFile(storePath, "utf8")) as { settings: { github: { cacheEpoch: string } } };
    expect(persisted.settings.github.cacheEpoch).toBe(normalized.settings.github.cacheEpoch);
    await expect(access(snapshotPath(legacyConfig))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(snapshotPath(otherConfig))).resolves.toBeUndefined();
    const renderKeys = (await listPersistentRenderedMarkdownCacheEntries()).map((entry) => entry.key);
    expect(renderKeys).not.toContain(legacyRenderKey);
    expect(renderKeys).toContain(otherRenderKey);
    expect(await readPersistentTranslatedPage(legacyTranslationKey)).toBeNull();
    expect(await readPersistentTranslatedPage(otherTranslationKey)).not.toBeNull();
  });

  it("uses a unique cache security epoch for every newly created store", () => {
    expect(DEFAULT_STORE().settings.github.cacheEpoch).not.toBe(DEFAULT_STORE().settings.github.cacheEpoch);
  });

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

  it.skipIf(process.platform === "win32")("repairs existing permissions and atomically saves private state", async () => {
    const storePath = await createStorePath();
    await writeStore(storePath, "Private");
    await chmod(path.dirname(storePath), 0o755);
    await chmod(storePath, 0o644);

    const { getStore, saveStore } = await importStore(storePath);
    const store = await getStore();
    expect((await stat(path.dirname(storePath))).mode & 0o777).toBe(0o700);
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);

    await chmod(path.dirname(storePath), 0o755);
    await chmod(storePath, 0o666);
    await saveStore(store);
    expect((await stat(path.dirname(storePath))).mode & 0o777).toBe(0o700);
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
  });
});
