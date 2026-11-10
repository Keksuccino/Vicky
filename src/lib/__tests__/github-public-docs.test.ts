import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docsSourceCache } from "@/lib/cache";
import { clearGitHubBlobMemory } from "@/lib/github-content-store";
import { loadGitHubDoc, loadPublicGitHubDoc, refreshGitHubDocsCache, saveGitHubDoc } from "@/lib/github";
import type { GitHubRuntimeConfig } from "@/lib/types";

import { createFakeGitHub, gitBlobShaOf, type FakeGitHub } from "./fixtures/fake-github-api";

const createConfig = (cacheEpoch: string): GitHubRuntimeConfig => ({ owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: "token", cacheEpoch });

const RUNTIME_DIRECTORY_VARIABLES = ["WIKI_DOCS_CACHE_DIR", "WIKI_MARKDOWN_CACHE_DIR"] as const;

describe("public GitHub document reads", () => {
  const previousEnvironment = new Map(RUNTIME_DIRECTORY_VARIABLES.map((name) => [name, process.env[name]]));
  let fake: FakeGitHub;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-public-docs-"));
    process.env.WIKI_DOCS_CACHE_DIR = path.join(tempDir, "docs-cache");
    process.env.WIKI_MARKDOWN_CACHE_DIR = path.join(tempDir, "markdown");
    docsSourceCache.clear();
    clearGitHubBlobMemory();
    fake = createFakeGitHub();
    fake.setFile("docs/home.md", "---\ntitle: Home\n---\n\nPublic home");
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    docsSourceCache.clear();
    clearGitHubBlobMemory();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("resolves many random slugs through one authoritative index without GitHub file probes", async () => {
    const releaseTree = fake.hold("tree");
    const config = createConfig("random-slug-containment");
    const reads = Array.from({ length: 250 }, (_, index) => loadPublicGitHubDoc(config, { slug: `random/path-${index}` }));

    await vi.waitFor(() => expect(fake.count("tree")).toBe(1));
    releaseTree();
    const results = await Promise.allSettled(reads);

    expect(results.every((result) => result.status === "rejected" && result.reason instanceof Error && /not found/i.test(result.reason.message))).toBe(true);
    expect(fake.count("tree")).toBe(1);
    expect(fake.count("blob")).toBe(1);
    expect(fake.count("contents")).toBe(0);
  });

  it("coalesces concurrent identical valid reads into one GitHub blob request", async () => {
    const releaseBlob = fake.hold("blob");
    const config = createConfig("identical-read-coalescing");
    const reads = Array.from({ length: 40 }, () => loadPublicGitHubDoc(config, { slug: "home" }));

    await vi.waitFor(() => expect(fake.count("blob")).toBe(1));
    releaseBlob();
    const pages = await Promise.all(reads);

    expect(pages).toHaveLength(40);
    expect(pages.every((page) => page.slug === "home" && page.content.includes("Public home"))).toBe(true);
    expect(fake.count("tree")).toBe(1);
    expect(fake.count("blob")).toBe(1);
    expect(fake.count("contents")).toBe(0);
  });

  it("keeps authenticated direct reads separate from public index authorization", async () => {
    const config = createConfig("admin-direct-read-separation");
    await expect(loadPublicGitHubDoc(config, { slug: "draft" })).rejects.toThrow(/not found/i);
    expect(fake.count("contents")).toBe(0);

    fake.setFile("docs/draft.md", "---\ntitle: Draft\n---\n\nEditor draft");
    const draft = await loadGitHubDoc(config, { slug: "draft" });
    expect(draft.slug).toBe("draft");
    expect(draft.content).toContain("Editor draft");
    expect(fake.requests.filter((request) => request.kind === "contents").map((request) => request.target)).toEqual(["docs/draft.md"]);
    await expect(loadPublicGitHubDoc(config, { slug: "draft" })).rejects.toThrow(/not found/i);
  });

  it("serves a page created by an authenticated save right away, despite an earlier public miss", async () => {
    const config = createConfig("save-invalidates-public-miss");
    await expect(loadPublicGitHubDoc(config, { slug: "new-page" })).rejects.toThrow(/not found/i);
    expect(fake.count("contents")).toBe(0);

    await saveGitHubDoc(config, { slug: "new-page", content: "Newly created content" });
    await expect(loadPublicGitHubDoc(config, { slug: "new-page" })).resolves.toMatchObject({ slug: "new-page", sha: gitBlobShaOf("Newly created content") });
    expect(fake.count("tree")).toBe(1);
    expect(fake.count("blob")).toBe(1);
    expect(fake.requests.filter((request) => request.kind === "contents").map((request) => request.target)).toEqual(["docs/new-page.md"]);
  });

  it("finds a page added on GitHub right after the refresh that indexes it", async () => {
    const config = createConfig("refresh-finds-new-page");
    await expect(loadPublicGitHubDoc(config, { slug: "added" })).rejects.toThrow(/not found/i);

    fake.setFile("docs/added.md", "---\ntitle: Added\n---\nAdded later");
    await refreshGitHubDocsCache(config);

    await expect(loadPublicGitHubDoc(config, { slug: "added" })).resolves.toMatchObject({ content: "Added later" });
    expect(fake.count("contents")).toBe(0);
  });

  it("rejects malformed public paths before any GitHub request", async () => {
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
    expect(fake.count()).toBe(0);
  });
});
