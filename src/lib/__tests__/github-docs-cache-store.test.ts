import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearGitHubBlobMemory, gitBlobSha, loadGitHubBlobs, storeCommittedGitHubBlob, sweepUnreferencedGitHubBlobs } from "@/lib/github-content-store";
import { blobFilePath, removeLegacyDocsSnapshots, sourceCacheFilePath } from "@/lib/github-docs-cache-files";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { readPersistentGitHubRepoIndex, writePersistentGitHubRepoIndex, type GitHubRepoIndex } from "@/lib/github-repo-index";
import type { GitHubRuntimeConfig } from "@/lib/types";

const config: GitHubRuntimeConfig = { owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: "old-private-token", cacheEpoch: "epoch-one" };

const shaOf = (markdown: string): string => gitBlobSha(Buffer.from(markdown, "utf8"));

const indexOf = (files: Record<string, string>): GitHubRepoIndex => ({
  checkedAt: "2026-05-05T10:00:00.000Z",
  files: new Map(Object.entries(files).map(([repoPath, sha]) => [repoPath, { sha, size: 1 }])),
  treeSha: "f".repeat(40),
});

describe("persistent docs cache", () => {
  let baseDir = "";

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(os.tmpdir(), "vicky-docs-cache-"));
    clearGitHubBlobMemory();
    // Nothing here may reach GitHub.
    vi.stubGlobal("fetch", () => Promise.reject(new Error("unexpected GitHub request")));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    clearGitHubBlobMemory();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("keeps the repository index private and never reuses it across credential or security-epoch rotation", async () => {
    const index = indexOf({ "docs/home.md": "a".repeat(40) });
    await writePersistentGitHubRepoIndex(config, index, baseDir);

    const indexPath = sourceCacheFilePath(baseDir, gitHubRuntimeCacheKey(config), "repo-index");
    expect(await readFile(indexPath, "utf8")).not.toContain(config.token);
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(indexPath))).mode & 0o777).toBe(0o700);
      expect((await stat(indexPath)).mode & 0o777).toBe(0o600);
      await chmod(indexPath, 0o644);
      await readPersistentGitHubRepoIndex(config, baseDir);
      expect((await stat(indexPath)).mode & 0o777).toBe(0o600);
    }

    await expect(readPersistentGitHubRepoIndex(config, baseDir)).resolves.toEqual(index);
    await expect(readPersistentGitHubRepoIndex({ ...config, token: "new-token" }, baseDir)).resolves.toBeNull();
    await expect(readPersistentGitHubRepoIndex({ ...config, cacheEpoch: "epoch-two" }, baseDir)).resolves.toBeNull();
  });

  it("stores blobs only under the SHA of their exact content and serves them from disk afterwards", async () => {
    const markdown = "---\ntitle: Home\n---\n\n## Welcome\n\nBody";
    await expect(storeCommittedGitHubBlob("0".repeat(40), markdown, baseDir)).resolves.toBeNull();
    const stored = await storeCommittedGitHubBlob(shaOf(markdown), markdown, baseDir);
    expect(stored).toMatchObject({ title: "Home", headings: [{ depth: 2, text: "Welcome", slug: "welcome" }], includeInPlaintextExport: true });
    expect(stored?.content).toBe(markdown.slice(markdown.indexOf("---\n\n") + 4));

    clearGitHubBlobMemory();
    const loaded = await loadGitHubBlobs(config, [shaOf(markdown)], baseDir);
    expect(loaded.get(shaOf(markdown))).toEqual(stored);
    if (process.platform !== "win32") {
      expect((await stat(blobFilePath(baseDir, shaOf(markdown)))).mode & 0o777).toBe(0o600);
    }
  });

  it("deletes only blobs that no persisted index references", async () => {
    const kept = "kept page";
    const orphaned = "orphaned page";
    await storeCommittedGitHubBlob(shaOf(kept), kept, baseDir);
    await storeCommittedGitHubBlob(shaOf(orphaned), orphaned, baseDir);
    await writePersistentGitHubRepoIndex(config, indexOf({ "docs/kept.md": shaOf(kept) }), baseDir);

    await expect(sweepUnreferencedGitHubBlobs(baseDir)).resolves.toBe(1);

    await expect(access(blobFilePath(baseDir, shaOf(kept)))).resolves.toBeUndefined();
    await expect(access(blobFilePath(baseDir, shaOf(orphaned)))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes every whole-docs snapshot file of the previous persistence format", async () => {
    const snapshotDir = path.join(baseDir, "snapshots");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(path.join(snapshotDir, `${"1".repeat(64)}.json`), "{}", "utf8");
    await writeFile(path.join(snapshotDir, `${"2".repeat(64)}.json`), "{}", "utf8");

    await expect(removeLegacyDocsSnapshots(baseDir)).resolves.toBe(2);
    await expect(readdir(baseDir)).resolves.toEqual([]);
  });
});
