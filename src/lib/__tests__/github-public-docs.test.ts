import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const githubState = vi.hoisted(() => ({
  branchRequests: 0,
  contentGate: null as Promise<void> | null,
  contentRequests: [] as string[],
  files: new Map<string, { markdown: string; sha: string }>(),
  treeGate: null as Promise<void> | null,
  treeRequests: 0,
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    repos = {
      getBranch: vi.fn(async () => {
        githubState.branchRequests += 1;
        return { data: { commit: { sha: "branch-sha", commit: { tree: { sha: "tree-sha" } } } } };
      }),
      getContent: vi.fn(async ({ path: repoPath }: { path: string }) => {
        githubState.contentRequests.push(repoPath);
        await githubState.contentGate;
        const file = githubState.files.get(repoPath);
        if (!file) {
          throw Object.assign(new Error("Document not found."), { status: 404 });
        }
        return { data: { type: "file", content: Buffer.from(file.markdown, "utf8").toString("base64"), encoding: "base64", sha: file.sha } };
      }),
      listCommits: vi.fn(async () => ({ data: [] })),
      createOrUpdateFileContents: vi.fn(async ({ content, path: repoPath }: { content: string; path: string }) => {
        githubState.files.set(repoPath, { markdown: Buffer.from(content, "base64").toString("utf8"), sha: "saved-file-sha" });
        return { data: { commit: { sha: "saved-commit-sha" }, content: { sha: "saved-file-sha" } } };
      }),
    };

    git = {
      getTree: vi.fn(async () => {
        githubState.treeRequests += 1;
        await githubState.treeGate;
        return {
          data: {
            tree: Array.from(githubState.files, ([repoPath, file]) => ({ path: repoPath, sha: file.sha, type: "blob" })),
          },
        };
      }),
    };
  },
}));

import { docsPageCache, docsSnapshotCache, docsTreeCache } from "@/lib/cache";
import { loadGitHubDoc, loadPublicGitHubDoc, saveGitHubDoc } from "@/lib/github";
import type { GitHubRuntimeConfig } from "@/lib/types";

const createConfig = (cacheEpoch: string): GitHubRuntimeConfig => ({ owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: "token", cacheEpoch });

describe("public GitHub document reads", () => {
  const previousSnapshotDir = process.env.WIKI_DOCS_SNAPSHOT_DIR;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-public-docs-"));
    process.env.WIKI_DOCS_SNAPSHOT_DIR = tempDir;
    docsPageCache.clear();
    docsSnapshotCache.clear();
    docsTreeCache.clear();
    githubState.branchRequests = 0;
    githubState.contentGate = null;
    githubState.contentRequests = [];
    githubState.files = new Map([
      ["docs/home.md", { markdown: "---\ntitle: Home\n---\n\nPublic home", sha: "home-sha" }],
    ]);
    githubState.treeGate = null;
    githubState.treeRequests = 0;
  });

  afterEach(async () => {
    if (previousSnapshotDir === undefined) {
      delete process.env.WIKI_DOCS_SNAPSHOT_DIR;
    } else {
      process.env.WIKI_DOCS_SNAPSHOT_DIR = previousSnapshotDir;
    }
    docsPageCache.clear();
    docsSnapshotCache.clear();
    docsTreeCache.clear();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves many random slugs through one authoritative tree without GitHub file probes", async () => {
    let releaseTree!: () => void;
    githubState.treeGate = new Promise<void>((resolve) => {
      releaseTree = resolve;
    });
    const config = createConfig("random-slug-containment");
    const reads = Array.from({ length: 250 }, (_, index) => loadPublicGitHubDoc(config, { slug: `random/path-${index}` }));

    await vi.waitFor(() => expect(githubState.treeRequests).toBe(1));
    releaseTree();
    const results = await Promise.allSettled(reads);

    expect(results.every((result) => result.status === "rejected" && result.reason instanceof Error && /not found/i.test(result.reason.message))).toBe(true);
    expect(githubState.branchRequests).toBe(1);
    expect(githubState.treeRequests).toBe(1);
    expect(githubState.contentRequests).toEqual([]);
  });

  it("coalesces concurrent identical valid reads into one GitHub file request", async () => {
    let releaseContent!: () => void;
    githubState.contentGate = new Promise<void>((resolve) => {
      releaseContent = resolve;
    });
    const config = createConfig("identical-read-coalescing");
    const reads = Array.from({ length: 40 }, () => loadPublicGitHubDoc(config, { slug: "home" }));

    await vi.waitFor(() => expect(githubState.contentRequests).toEqual(["docs/home.md"]));
    releaseContent();
    const pages = await Promise.all(reads);

    expect(pages).toHaveLength(40);
    expect(pages.every((page) => page.slug === "home" && page.content.includes("Public home"))).toBe(true);
    expect(githubState.branchRequests).toBe(1);
    expect(githubState.treeRequests).toBe(1);
    expect(githubState.contentRequests).toEqual(["docs/home.md"]);
  });

  it("keeps authenticated direct reads separate from public tree authorization", async () => {
    const config = createConfig("admin-direct-read-separation");
    await expect(loadPublicGitHubDoc(config, { slug: "draft" })).rejects.toThrow(/not found/i);
    expect(githubState.contentRequests).toEqual([]);

    githubState.files.set("docs/draft.md", { markdown: "---\ntitle: Draft\n---\n\nEditor draft", sha: "draft-sha" });
    const draft = await loadGitHubDoc(config, { slug: "draft" });
    expect(draft.slug).toBe("draft");
    expect(draft.content).toContain("Editor draft");
    expect(githubState.contentRequests).toEqual(["docs/draft.md"]);
  });

  it("invalidates a public miss generation when an authenticated save creates the page", async () => {
    const config = createConfig("save-invalidates-public-miss");
    await expect(loadPublicGitHubDoc(config, { slug: "new-page" })).rejects.toThrow(/not found/i);
    expect(githubState.contentRequests).toEqual([]);

    await saveGitHubDoc(config, { slug: "new-page", content: "Newly created content" });
    await expect(loadPublicGitHubDoc(config, { slug: "new-page" })).resolves.toMatchObject({ slug: "new-page", sha: "saved-file-sha" });
    expect(githubState.treeRequests).toBe(2);
    expect(githubState.contentRequests).toEqual(["docs/new-page.md"]);
  });

  it("rejects malformed public paths before any tree or file request", async () => {
    const config = createConfig("invalid-public-paths");
    const invalidLocators = [
      { slug: "../secret" },
      { slug: `page-${"x".repeat(600)}` },
      { path: "guide/page.json" },
      { path: "guide\\page.md" },
      { path: "home.md", slug: "home" },
    ];

    for (const locator of invalidLocators) {
      await expect(loadPublicGitHubDoc(config, locator)).rejects.toMatchObject({ status: 400 });
    }
    expect(githubState.branchRequests).toBe(0);
    expect(githubState.treeRequests).toBe(0);
    expect(githubState.contentRequests).toEqual([]);
  });
});
