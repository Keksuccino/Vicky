import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deletePersistentGitHubDocsSnapshot,
  gitHubDocsSnapshotSourceKey,
  readPersistentGitHubDocsSnapshot,
  writePersistentGitHubDocsSnapshot,
} from "@/lib/docs-snapshot-store";
import type { GitHubDocPage, GitHubRuntimeConfig } from "@/lib/types";

const config: GitHubRuntimeConfig = {
  owner: "owner",
  repo: "repo",
  branch: "main",
  docsPath: "docs",
  token: "token",
};

const page: GitHubDocPage = {
  path: "home.md",
  slug: "home",
  sha: "sha",
  title: "Home",
  description: "",
  content: "## Home",
  markdown: "## Home",
  headings: [{ depth: 2, text: "Home", slug: "home" }],
  includeInPlaintextExport: true,
};

describe("docs snapshot store", () => {
  const previousSnapshotDir = process.env.WIKI_DOCS_SNAPSHOT_DIR;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-docs-snapshot-"));
    process.env.WIKI_DOCS_SNAPSHOT_DIR = tempDir;
  });

  afterEach(async () => {
    if (previousSnapshotDir === undefined) {
      delete process.env.WIKI_DOCS_SNAPSHOT_DIR;
    } else {
      process.env.WIKI_DOCS_SNAPSHOT_DIR = previousSnapshotDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists fresh snapshots and ignores expired snapshots", async () => {
    await writePersistentGitHubDocsSnapshot(config, {
      fetchedAt: "2026-05-05T10:00:00.000Z",
      expiresAt: "2999-05-05T10:00:00.000Z",
      tree: [{ path: page.path, slug: page.slug, name: page.title }],
      pages: [page],
    });

    if (process.platform !== "win32") {
      const [snapshotFileName] = await readdir(tempDir);
      const snapshotPath = path.join(tempDir, snapshotFileName);
      expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
      expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);

      await chmod(tempDir, 0o755);
      await chmod(snapshotPath, 0o644);
      await readPersistentGitHubDocsSnapshot(config);
      expect((await stat(tempDir)).mode & 0o777).toBe(0o700);
      expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600);
    }

    expect(await readPersistentGitHubDocsSnapshot(config)).toMatchObject({
      tree: [{ path: "home.md", slug: "home", name: "Home" }],
      pages: [{ slug: "home", title: "Home" }],
    });

    await writePersistentGitHubDocsSnapshot(config, {
      fetchedAt: "2026-05-05T10:00:00.000Z",
      expiresAt: "2000-05-05T10:00:00.000Z",
      tree: [{ path: page.path, slug: page.slug, name: page.title }],
      pages: [page],
    });

    expect(await readPersistentGitHubDocsSnapshot(config)).toBeNull();
    expect(await readPersistentGitHubDocsSnapshot(config, { allowExpired: true })).toMatchObject({
      pages: [{ slug: "home" }],
    });
    expect(await deletePersistentGitHubDocsSnapshot(config)).toBe(true);
  });

  it("does not reuse a snapshot across credential or security-epoch rotation", async () => {
    const authorizedConfig = { ...config, token: "old-private-token", cacheEpoch: "epoch-one" };
    expect(gitHubDocsSnapshotSourceKey(authorizedConfig)).not.toContain("old-private-token");
    await writePersistentGitHubDocsSnapshot(authorizedConfig, {
      fetchedAt: "2026-05-05T10:00:00.000Z",
      expiresAt: "2999-05-05T10:00:00.000Z",
      tree: [{ path: page.path, slug: page.slug, name: page.title }],
      pages: [page],
    });

    await expect(readPersistentGitHubDocsSnapshot({ ...authorizedConfig, token: "new-token" })).resolves.toBeNull();
    await expect(readPersistentGitHubDocsSnapshot({ ...authorizedConfig, cacheEpoch: "epoch-two" })).resolves.toBeNull();
    await expect(readPersistentGitHubDocsSnapshot(authorizedConfig)).resolves.toMatchObject({ pages: [{ slug: "home" }] });
  });
});
