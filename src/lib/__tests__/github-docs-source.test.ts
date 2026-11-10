import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docsSourceCache, getDocsCacheTtlMs, setDocsCacheTtlMs } from "@/lib/cache";
import { clearGitHubBlobMemory } from "@/lib/github-content-store";
import {
  listMarkdownDocsTreePagesWithTitles,
  loadGitHubDoc,
  loadGitHubRepoIndex,
  loadPublicGitHubDoc,
  loadPublicGitHubDocMetadata,
  refreshGitHubDocsCache,
  saveGitHubDoc,
} from "@/lib/github";
import { loadGitHubLocalizationStatuses } from "@/lib/github-localization";
import type { GitHubRuntimeConfig } from "@/lib/types";

import { createFakeGitHub, gitBlobShaOf, type FakeGitHub } from "./fixtures/fake-github-api";

const RUNTIME_DIRECTORY_VARIABLES = ["WIKI_DOCS_CACHE_DIR", "WIKI_MARKDOWN_CACHE_DIR", "WIKI_TRANSLATION_CACHE_DIR"] as const;

const createConfig = (): GitHubRuntimeConfig => ({ owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: "token", cacheEpoch: randomUUID() });

const page = (title: string, body: string): string => `---\ntitle: ${title}\n---\n${body}`;

/** Forgets everything held in memory, like a process restart; the persistent cache stays. */
const simulateRestart = (): void => {
  docsSourceCache.clear();
  clearGitHubBlobMemory();
};

describe("GitHub docs source loading", () => {
  const previousEnvironment = new Map(RUNTIME_DIRECTORY_VARIABLES.map((name) => [name, process.env[name]]));
  const previousTtlMs = getDocsCacheTtlMs();
  let fake: FakeGitHub;
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-docs-source-"));
    process.env.WIKI_DOCS_CACHE_DIR = path.join(tempDir, "docs-cache");
    process.env.WIKI_MARKDOWN_CACHE_DIR = path.join(tempDir, "markdown");
    process.env.WIKI_TRANSLATION_CACHE_DIR = path.join(tempDir, "translations");
    simulateRestart();
    setDocsCacheTtlMs(3_600_000);
    fake = createFakeGitHub();
    fake.setFile("docs/home.md", page("Home", "Welcome home"));
    fake.setFile("docs/guide/setup.md", page("Setup", "Install it"));
    fake.setFile("docs/guide/usage.mdx", page("Usage", "Use it"));
    fake.setFile("localizations/de/home.md", page("Start", "Willkommen"));
    fake.setFile("README.md", "# Repository readme");
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setDocsCacheTtlMs(previousTtlMs);
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    simulateRestart();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads a cold start with one tree request, one blob request per page, and batched commit metadata", async () => {
    for (let index = 0; index < 57; index += 1) {
      fake.setFile(`docs/generated/page-${index}.md`, page(`Page ${index}`, `Generated body ${index}`));
    }
    const config = createConfig();

    const { items, pages } = await listMarkdownDocsTreePagesWithTitles(config);

    expect(pages).toHaveLength(60);
    expect(items.find((item) => item.slug === "guide/usage")).toMatchObject({ name: "Usage", path: "guide/usage.mdx" });
    expect(pages.find((entry) => entry.slug === "home")).toMatchObject({ updatedAt: expect.any(String), updatedBy: "writer" });
    expect(fake.count("tree")).toBe(1);
    expect(fake.count("blob")).toBe(60);
    expect(fake.count("graphql")).toBe(2);
    expect(fake.count()).toBe(63);
  });

  it("indexes every Markdown file of the repository, localizations included", async () => {
    const index = await loadGitHubRepoIndex(createConfig());

    expect(Array.from(index.files.keys()).sort()).toEqual(["README.md", "docs/guide/setup.md", "docs/guide/usage.mdx", "docs/home.md", "localizations/de/home.md"]);
    expect(index.files.get("localizations/de/home.md")?.sha).toBe(gitBlobShaOf(page("Start", "Willkommen")));
    expect(fake.count("blob")).toBe(3);
  });

  it("refreshes an unchanged repository with a single conditional tree request", async () => {
    const config = createConfig();
    await refreshGitHubDocsCache(config);
    fake.resetRequests();

    await refreshGitHubDocsCache(config);

    expect(fake.requests).toEqual([expect.objectContaining({ kind: "tree" })]);
  });

  it("downloads only the changed page and looks up its commit metadata once", async () => {
    const config = createConfig();
    await refreshGitHubDocsCache(config);
    fake.setFile("docs/guide/setup.md", page("Setup", "Install it differently"), "Reviewer");
    fake.resetRequests();

    await refreshGitHubDocsCache(config);

    expect(fake.count("tree")).toBe(1);
    expect(fake.count("blob")).toBe(1);
    expect(fake.count("graphql")).toBe(1);
    expect(fake.count()).toBe(3);
    await expect(loadPublicGitHubDoc(config, { slug: "guide/setup" })).resolves.toMatchObject({ content: "Install it differently", updatedBy: "reviewer" });
  });

  it("ignores changes outside the docs path apart from the tree request", async () => {
    const config = createConfig();
    await refreshGitHubDocsCache(config);
    fake.setFile("localizations/de/home.md", page("Start", "Neu"));
    fake.resetRequests();

    await refreshGitHubDocsCache(config);

    expect(fake.requests).toEqual([expect.objectContaining({ kind: "tree" })]);
    expect((await loadGitHubRepoIndex(config)).files.get("localizations/de/home.md")?.sha).toBe(gitBlobShaOf(page("Start", "Neu")));
  });

  it("restarts from the persisted index, blobs, and commit metadata without downloading anything", async () => {
    const config = createConfig();
    await refreshGitHubDocsCache(config);
    simulateRestart();
    fake.resetRequests();

    const loaded = await loadPublicGitHubDoc(config, { slug: "home" });

    expect(loaded).toMatchObject({ content: "Welcome home", updatedBy: "writer" });
    expect(fake.count()).toBe(0);
  });

  it("stops serving a page deleted on GitHub after the next refresh", async () => {
    const config = createConfig();
    await expect(loadPublicGitHubDoc(config, { slug: "guide/setup" })).resolves.toMatchObject({ title: "Setup" });

    fake.deleteFile("docs/guide/setup.md");
    await refreshGitHubDocsCache(config);

    await expect(loadPublicGitHubDoc(config, { slug: "guide/setup" })).rejects.toMatchObject({ status: 404 });
    await expect(loadGitHubDoc(config, { slug: "guide/setup" })).rejects.toMatchObject({ status: 404 });
    expect((await listMarkdownDocsTreePagesWithTitles(config)).items.map((item) => item.slug)).toEqual(["guide/usage", "home"]);
  });

  it("keeps answering public reads with the current pages while an explicit refresh runs", async () => {
    const config = createConfig();
    await refreshGitHubDocsCache(config);
    fake.setFile("docs/home.md", page("Home", "Welcome back"));
    const releaseBlobs = fake.hold("blob");

    const refresh = refreshGitHubDocsCache(config);
    await vi.waitFor(() => expect(fake.count("blob")).toBe(4));
    const duringRefresh = await Promise.all(Array.from({ length: 20 }, () => loadPublicGitHubDoc(config, { slug: "home" })));
    expect(duringRefresh.every((entry) => entry.content === "Welcome home")).toBe(true);

    releaseBlobs();
    await refresh;
    await expect(loadPublicGitHubDoc(config, { slug: "home" })).resolves.toMatchObject({ content: "Welcome back" });
  });

  it("serves the current pages after the refresh interval and refreshes them in the background", async () => {
    const config = createConfig();
    await refreshGitHubDocsCache(config);
    fake.setFile("docs/home.md", page("Home", "Background update"));
    fake.resetRequests();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + getDocsCacheTtlMs() + 1_000);

    await expect(loadPublicGitHubDoc(config, { slug: "home" })).resolves.toMatchObject({ content: "Welcome home" });
    await vi.waitFor(async () => {
      expect((await loadPublicGitHubDoc(config, { slug: "home" })).content).toBe("Background update");
    });
    expect(fake.count("tree")).toBe(1);
    expect(fake.count("blob")).toBe(1);
  });

  it("does not fail an explicit refresh into errors for public readers when GitHub is unavailable", async () => {
    const config = createConfig();
    await refreshGitHubDocsCache(config);
    fake.intercept(() => new Response(JSON.stringify({ message: "Not allowed" }), { status: 401, headers: { "content-type": "application/json" } }));

    await expect(refreshGitHubDocsCache(config)).rejects.toMatchObject({ status: 401 });
    await expect(loadPublicGitHubDoc(config, { slug: "home" })).resolves.toMatchObject({ content: "Welcome home" });
  });

  it("loads files over 1 MB through the blob API, for indexed and unindexed pages", async () => {
    const largeBody = `Large ${"x".repeat(1_200_000)}`;
    fake.setFile("docs/large.md", page("Large", largeBody));
    const config = createConfig();

    await expect(loadPublicGitHubDoc(config, { slug: "large" })).resolves.toMatchObject({ title: "Large", content: largeBody });

    fake.setFile("docs/fresh-large.md", page("Fresh", largeBody));
    await expect(loadGitHubDoc(config, { slug: "fresh-large" })).resolves.toMatchObject({ title: "Fresh", content: largeBody });
    expect(fake.requests.filter((request) => request.kind === "contents").map((request) => request.target)).toEqual(["docs/fresh-large.md"]);
  });

  it("lists a truncated tree level by level instead of dropping pages", async () => {
    fake.truncateRecursiveTreesAbove(3);
    const config = createConfig();

    const { pages } = await listMarkdownDocsTreePagesWithTitles(config);

    expect(pages.map((entry) => entry.path)).toEqual(["guide/setup.md", "guide/usage.mdx", "home.md"]);
    // Recursive listings: root (truncated), docs/ (truncated), localizations/, docs/guide/.
    // Level listings: root and docs/.
    const treeRequests = fake.requests.filter((request) => request.kind === "tree");
    expect(treeRequests.filter((request) => request.recursive)).toHaveLength(4);
    expect(treeRequests.filter((request) => !request.recursive)).toHaveLength(2);
  });

  it("shows a saved page immediately and needs no download for it on the next refresh", async () => {
    const config = createConfig();
    await refreshGitHubDocsCache(config);
    fake.resetRequests();

    const saved = await saveGitHubDoc(config, { path: "home.md", title: "Home", content: "Saved in the editor" });

    expect(fake.requests.map((request) => request.kind)).toEqual(["contents", "put-contents"]);
    await expect(loadPublicGitHubDoc(config, { slug: "home" })).resolves.toMatchObject({ content: "Saved in the editor\n", sha: saved.page.sha, updatedBy: "Editor" });
    await expect(loadPublicGitHubDocMetadata(config, { slug: "home" })).resolves.toMatchObject({ updatedBy: "Editor" });
    expect(fake.count()).toBe(2);

    await refreshGitHubDocsCache(config);
    expect(fake.requests.slice(2).map((request) => request.kind)).toEqual(["tree"]);
  });

  it("keeps front-matter keys an author added when the editor saves a page", async () => {
    fake.setFile("docs/home.md", "---\ntitle: Home\nnav_order: 2\ndate: 2024-01-01\n---\nWelcome home\n");
    const config = createConfig();

    await saveGitHubDoc(config, { path: "home.md", title: "Home page", description: "Start here", content: "Welcome back" });

    expect(fake.files.get("docs/home.md")?.toString("utf8")).toBe("---\ntitle: Home page\nnav_order: 2\ndate: 2024-01-01\ndescription: Start here\n---\nWelcome back\n");
  });

  it("keeps every loader within the global request cap", async () => {
    for (let index = 0; index < 40; index += 1) {
      fake.setFile(`docs/bulk/page-${index}.md`, page(`Bulk ${index}`, `Body ${index}`));
      fake.setFile(`localizations/de/bulk/page-${index}.md`, page(`Masse ${index}`, `Inhalt ${index}`));
    }
    fake.setLatency(3);
    const config = createConfig();

    const sourceLoad = listMarkdownDocsTreePagesWithTitles(config);
    const statusLoad = sourceLoad.then(({ pages }) =>
      Promise.all([
        loadGitHubLocalizationStatuses({ config, languageCodes: ["de"], localizationPath: "localizations", sourcePages: pages }),
        refreshGitHubDocsCache(config),
        ...pages.slice(0, 10).map((entry) => loadGitHubDoc(config, { slug: `${entry.slug}-draft` }).catch(() => null)),
      ]),
    );
    await Promise.all([sourceLoad, statusLoad]);

    expect(fake.maxInFlight).toBeLessThanOrEqual(8);
    expect(fake.maxInFlight).toBeGreaterThan(1);
  });
});
