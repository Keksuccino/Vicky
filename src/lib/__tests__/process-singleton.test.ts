import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubRuntimeConfig } from "@/lib/types";

const githubState = vi.hoisted(() => ({ treeRequests: 0 }));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    repos = {
      getBranch: vi.fn(async () => ({ data: { commit: { sha: "branch-sha", commit: { tree: { sha: "tree-sha" } } } } })),
    };

    git = {
      getTree: vi.fn(async () => {
        githubState.treeRequests += 1;
        return { data: { tree: [{ path: "docs/home.md", sha: "home-sha", type: "blob" }] } };
      }),
    };
  },
}));

const RUNTIME_DIRECTORY_VARIABLES = ["WIKI_DOCS_SNAPSHOT_DIR", "WIKI_MARKDOWN_CACHE_DIR", "WIKI_STORE_FILE_PATH", "WIKI_TRANSLATION_CACHE_DIR"] as const;

// Next.js evaluates every library module once per bundle graph (server-rendered pages, route
// handlers, ...). Importing again after resetting the module registry creates exactly such a
// second, independent copy of the module and of everything it imports.
const importModuleCopy = async <T>(load: () => Promise<T>): Promise<T> => {
  vi.resetModules();
  return load();
};

const createConfig = (): GitHubRuntimeConfig => ({ owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: "token", cacheEpoch: randomUUID() });

describe("process-wide runtime state", () => {
  const previousEnvironment = new Map(RUNTIME_DIRECTORY_VARIABLES.map((name) => [name, process.env[name]]));
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-process-singleton-"));
    process.env.WIKI_DOCS_SNAPSHOT_DIR = path.join(tempDir, "snapshots");
    process.env.WIKI_MARKDOWN_CACHE_DIR = path.join(tempDir, "markdown");
    process.env.WIKI_STORE_FILE_PATH = path.join(tempDir, "wiki-store.json");
    process.env.WIKI_TRANSLATION_CACHE_DIR = path.join(tempDir, "translations");
    githubState.treeRequests = 0;
  });

  afterEach(async () => {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a registered value once and resolves it from every module copy", async () => {
    const name = `test.${randomUUID()}`;
    const create = vi.fn(() => ({ entries: new Map<string, number>() }));
    const firstCopy = await importModuleCopy(() => import("@/lib/process-singleton.mjs"));
    const secondCopy = await importModuleCopy(() => import("@/lib/process-singleton.mjs"));

    expect(secondCopy).not.toBe(firstCopy);
    expect(secondCopy.peekProcessSingleton(name)).toBeUndefined();
    const value = firstCopy.processSingleton(name, create);

    expect(secondCopy.processSingleton(name, create)).toBe(value);
    expect(secondCopy.peekProcessSingleton(name)).toBe(value);
    expect(create).toHaveBeenCalledOnce();
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for(`vicky.${name}`)];
  });

  it("shares the docs caches between module copies", async () => {
    const pageCopy = await importModuleCopy(() => import("@/lib/cache"));
    const routeCopy = await importModuleCopy(() => import("@/lib/cache"));

    expect(routeCopy.docsTreeCache).toBe(pageCopy.docsTreeCache);
    expect(routeCopy.docsPageCache).toBe(pageCopy.docsPageCache);
    expect(routeCopy.renderedMarkdownCache).toBe(pageCopy.renderedMarkdownCache);
  });

  it("stops serving a docs tree cached by one copy after another copy invalidates the source", async () => {
    const config = createConfig();
    const pageCopy = await importModuleCopy(() => import("@/lib/github"));
    const routeCopy = await importModuleCopy(() => import("@/lib/github"));

    await expect(pageCopy.listMarkdownDocsTree(config)).resolves.toEqual([expect.objectContaining({ slug: "home" })]);
    await routeCopy.clearGitHubDocsCache(config);
    await expect(pageCopy.listMarkdownDocsTree(config)).resolves.toEqual([expect.objectContaining({ slug: "home" })]);

    expect(githubState.treeRequests).toBe(2);
  });

  it("coalesces concurrent cold loads started by different copies into one upstream request", async () => {
    const config = createConfig();
    const pageCopy = await importModuleCopy(() => import("@/lib/github"));
    const routeCopy = await importModuleCopy(() => import("@/lib/github"));

    const [pageTree, routeTree] = await Promise.all([pageCopy.listMarkdownDocsTree(config), routeCopy.listMarkdownDocsTree(config)]);

    expect(routeTree).toBe(pageTree);
    expect(githubState.treeRequests).toBe(1);
  });

  it("keeps API error statuses when another copy created the error", async () => {
    const pageCopy = await importModuleCopy(() => import("@/lib/http"));
    const routeCopy = await importModuleCopy(() => import("@/lib/http"));
    const error = new routeCopy.ApiError(404, "missing");

    expect(error).toBeInstanceOf(pageCopy.ApiError);
    expect(pageCopy.resolvePublicError(error, { context: "process-singleton-test" }).status).toBe(404);
  });

  it("serves settings saved through another copy instead of a stale read cache", async () => {
    const pageCopy = await importModuleCopy(() => import("@/lib/store"));
    const routeCopy = await importModuleCopy(() => import("@/lib/store"));
    const siteTitle = randomUUID();

    await pageCopy.getStore();
    await routeCopy.updateStore((store) => {
      store.settings.siteTitle = siteTitle;
    });

    expect((await pageCopy.getStore()).settings.siteTitle).toBe(siteTitle);
  });
});
