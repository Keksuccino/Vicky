import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docsSourceCache, renderedMarkdownCache } from "@/lib/cache";
import { invalidateGitHubRuntimeCaches } from "@/lib/github-cache-invalidation";
import { clearGitHubBlobMemory } from "@/lib/github-content-store";
import {
  clearMarkdownRenderCache,
  createMarkdownRenderCacheStatus,
} from "@/lib/markdown-render-cache-admin";
import { listPersistentRenderedMarkdownCacheEntries } from "@/lib/markdown-render-cache-store";
import { getMarkdownRenderCacheWarmJob, startMarkdownRenderCacheWarmJob } from "@/lib/markdown-render-cache-warm-job";
import type {
  DocsStore,
  GitHubRuntimeConfig,
} from "@/lib/types";

import { createFakeGitHub, type FakeGitHub } from "./fixtures/fake-github-api";

const config: GitHubRuntimeConfig = {
  owner: "owner",
  repo: "repo",
  branch: "main",
  docsPath: "docs",
  token: "token",
  cacheEpoch: "markdown-cache-admin-test",
};

const store = {
  version: 13,
  settings: {
    autoTranslate: {
      enabled: true,
      openRouterModel: "openai/gpt-5.4-mini",
      requestTimeoutMs: 300_000,
      localizationPath: "localizations",
      languages: [
        { name: "English (US)", code: "en-US", icon: "us", enabled: true },
        { name: "German", code: "de", icon: "de", enabled: true },
      ],
    },
  },
} as unknown as DocsStore;

describe("markdown render cache admin helpers", () => {
  const previousCacheDir = process.env.WIKI_MARKDOWN_CACHE_DIR;
  const previousDocsCacheDir = process.env.WIKI_DOCS_CACHE_DIR;
  let cacheDir = "";
  let docsCacheDir = "";
  let fake: FakeGitHub;

  /** Runs a warm job to its end and returns its final state. */
  const warmCache = async () => {
    startMarkdownRenderCacheWarmJob({ config, store });
    await vi.waitFor(() => expect(getMarkdownRenderCacheWarmJob()?.status).not.toBe("running"));
    return getMarkdownRenderCacheWarmJob();
  };

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-markdown-admin-cache-"));
    docsCacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-markdown-admin-docs-"));
    process.env.WIKI_MARKDOWN_CACHE_DIR = cacheDir;
    process.env.WIKI_DOCS_CACHE_DIR = docsCacheDir;
    renderedMarkdownCache.clear();
    docsSourceCache.clear();
    clearGitHubBlobMemory();
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("vicky.markdownRender.warmJobSlot")];
    fake = createFakeGitHub();
    fake.setFile("docs/home.md", "---\ntitle: Home\n---\n## Home");
    fake.setFile("docs/advanced.md", "---\ntitle: Advanced\n---\n## Advanced");
    fake.setFile("localizations/de/home.md", "---\ntitle: Startseite\n---\n## Startseite");
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const [name, value] of [["WIKI_MARKDOWN_CACHE_DIR", previousCacheDir], ["WIKI_DOCS_CACHE_DIR", previousDocsCacheDir]] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    renderedMarkdownCache.clear();
    docsSourceCache.clear();
    clearGitHubBlobMemory();
    await rm(cacheDir, { recursive: true, force: true });
    await rm(docsCacheDir, { recursive: true, force: true });
  });

  it("caches only missing current source and translated HTML variants", async () => {
    const initialStatus = await createMarkdownRenderCacheStatus({ config, store });
    expect(initialStatus.totalPages).toBe(2);
    expect(initialStatus.totalVariants).toBe(3);
    expect(initialStatus.cachedVariants).toBe(0);

    const firstWarm = await warmCache();
    expect(firstWarm).toMatchObject({ status: "completed", phase: "finished", totalVariants: 3, missingVariants: 3, processedVariants: 3, renderedVariants: 3, skippedVariants: 0, failedVariants: 0 });
    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(3);
    const warmedStatus = await createMarkdownRenderCacheStatus({ config, store });
    expect(warmedStatus.cacheDirectory).toBe(cacheDir);
    expect(warmedStatus.currentSourceEntries).toBe(3);
    expect(warmedStatus.globalEntries).toBe(3);
    expect(warmedStatus.otherSourceEntries).toBe(0);

    const secondWarm = await warmCache();
    expect(secondWarm).toMatchObject({ status: "completed", missingVariants: 0, renderedVariants: 0 });
    expect(secondWarm?.id).not.toBe(firstWarm?.id);
    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(3);

    const homeClear = await clearMarkdownRenderCache({ config, slug: "home" });
    expect(homeClear).toMatchObject({ clearedEntries: 2, scope: "page", slug: "home" });

    if (process.platform !== "win32") {
      const pagesDir = path.join(cacheDir, "pages");
      const remainingPageFiles = await readdir(pagesDir);
      expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
      expect((await stat(pagesDir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(cacheDir, "metadata.json"))).mode & 0o777).toBe(0o600);
      await Promise.all(remainingPageFiles.map(async (fileName) => expect((await stat(path.join(pagesDir, fileName))).mode & 0o777).toBe(0o600)));
    }

    const afterHomeClear = await createMarkdownRenderCacheStatus({ config, store });
    expect(afterHomeClear.cachedVariants).toBe(1);
    expect(afterHomeClear.lastMutation).toMatchObject({
      deletedEntries: 2,
      reason: "admin-clear-page",
      scope: "page",
      target: "home",
    });
    expect(afterHomeClear.pages.find((page) => page.slug === "home")?.cachedVariants).toBe(0);
    expect(afterHomeClear.pages.find((page) => page.slug === "advanced")?.cachedVariants).toBe(1);

    const allClear = await clearMarkdownRenderCache({ config });
    expect(allClear).toMatchObject({ clearedEntries: 1, scope: "all" });
    const afterAllClear = await createMarkdownRenderCacheStatus({ config, store });
    expect(afterAllClear.cachedVariants).toBe(0);
    expect(afterAllClear.lastMutation).toMatchObject({
      deletedEntries: 1,
      reason: "admin-clear-current-source",
      scope: "all",
    });
  });

  it("warms in the background: returns at once, reports progress, and finishes", async () => {
    // The docs view and its source pages are loaded; the German translation still has to be downloaded.
    await createMarkdownRenderCacheStatus({ config, store });
    const releaseBlobs = fake.hold("blob");

    const started = startMarkdownRenderCacheWarmJob({ config, store });
    expect(started).toMatchObject({ status: "running", phase: "planning", processedVariants: 0 });
    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(0);

    await vi.waitFor(() => expect(getMarkdownRenderCacheWarmJob()).toMatchObject({ phase: "rendering", missingVariants: 3, processedVariants: 2, renderedVariants: 2 }));
    expect(getMarkdownRenderCacheWarmJob()?.status).toBe("running");
    expect(getMarkdownRenderCacheWarmJob()?.etaSeconds).toEqual(expect.any(Number));
    // Starting again while it runs returns the running job.
    expect(startMarkdownRenderCacheWarmJob({ config, store }).id).toBe(started.id);

    releaseBlobs();
    await vi.waitFor(() => expect(getMarkdownRenderCacheWarmJob()).toMatchObject({ id: started.id, status: "completed", phase: "finished", processedVariants: 3, renderedVariants: 3, etaSeconds: null }));
    expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(3);
  });

  it("reports variants that cannot be rendered and still finishes", async () => {
    await createMarkdownRenderCacheStatus({ config, store });
    fake.intercept((request) => (request.kind === "blob" ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } }) : undefined));

    await expect(warmCache()).resolves.toMatchObject({ status: "completed_with_failures", processedVariants: 3, renderedVariants: 2, failedVariants: 1, failures: [{ languageCode: "de", slug: "home" }] });
  });

  it("fails cleanly when the docs source changes while it runs, and a later job starts again", async () => {
    await createMarkdownRenderCacheStatus({ config, store });
    const releaseBlobs = fake.hold("blob");
    const started = startMarkdownRenderCacheWarmJob({ config, store });
    await vi.waitFor(() => expect(getMarkdownRenderCacheWarmJob()?.processedVariants).toBe(2));

    await invalidateGitHubRuntimeCaches(config);
    releaseBlobs();

    await vi.waitFor(() => expect(getMarkdownRenderCacheWarmJob()).toMatchObject({ id: started.id, status: "failed", phase: "finished", error: expect.any(String) }));
    const next = await warmCache();
    expect(next).toMatchObject({ status: "completed", failedVariants: 0 });
    expect(next?.id).not.toBe(started.id);
  });

  it("fails a job that stops making progress instead of leaving it running", async () => {
    await createMarkdownRenderCacheStatus({ config, store });
    const releaseBlobs = fake.hold("blob");
    // Only the watchdog's clock is faked; the job's own I/O and turns of the event loop stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const hung = startMarkdownRenderCacheWarmJob({ config, store });
      await vi.waitFor(() => expect(getMarkdownRenderCacheWarmJob()?.processedVariants).toBe(2));

      vi.advanceTimersByTime(4 * 60_000);
      expect(getMarkdownRenderCacheWarmJob()?.status).toBe("running");
      vi.advanceTimersByTime(2 * 60_000);
      expect(getMarkdownRenderCacheWarmJob()).toMatchObject({ id: hung.id, status: "failed", phase: "finished", error: expect.any(String) });
    } finally {
      vi.useRealTimers();
      releaseBlobs();
    }
    // The variant that was waiting still finishes; let it write into this test's directory.
    await vi.waitFor(async () => expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(3));
  });
});
