import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ paths: [] as string[] }));

// Records every file read, so the cache tests can tell index reads from entry reads.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFileSpy = (async (...args: Parameters<typeof actual.readFile>) => {
    reads.paths.push(String(args[0]));
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, readFile: readFileSpy };
});

import { renderedMarkdownCache } from "@/lib/cache";
import {
  deletePersistentRenderedMarkdownWhere,
  flushRenderedMarkdownCacheIndex,
  hasPersistentRenderedMarkdown,
  listPersistentRenderedMarkdownCacheEntries,
  readPersistentRenderedMarkdown,
  writePersistentRenderedMarkdown,
} from "@/lib/markdown-render-cache-store";
import { MARKDOWN_RENDER_VERSION } from "@/lib/markdown-rendering-shared";
import {
  renderGitHubDocPageMarkdown,
  renderMarkdownToHtml,
} from "@/lib/markdown-server-renderer";
import type { GitHubDocPage, GitHubRuntimeConfig } from "@/lib/types";

const config: GitHubRuntimeConfig = {
  owner: "Keksuccino",
  repo: "Docs",
  branch: "main",
  docsPath: "docs",
  token: "token",
};

const createPage = (content: string): GitHubDocPage => ({
  path: "home.md",
  slug: "home",
  sha: "sha",
  title: "Home",
  description: "",
  content,
  markdown: content,
  headings: [],
  includeInPlaintextExport: true,
});

const keys = {
  home: "source-a|markdown-render|v|home|en-us|1111",
  guide: "source-a|markdown-render|v|guide|de|2222",
  other: "source-b|markdown-render|v|home|en-us|3333",
};

const entryFileName = (key: string): string => `${createHash("sha256").update(key).digest("hex")}.json`;

/** Forgets the in-memory cache index, like a process restart; the files stay. */
const forgetCacheIndex = (): void => {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("vicky.markdownRender.cacheIndex")];
};

const listCacheFiles = async (cacheDir: string): Promise<string[]> => {
  try {
    return await readdir(path.join(cacheDir, "pages"));
  } catch {
    return [];
  }
};

describe("server markdown renderer", () => {
  const previousCacheDir = process.env.WIKI_MARKDOWN_CACHE_DIR;
  let cacheDir = "";

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-markdown-cache-"));
    process.env.WIKI_MARKDOWN_CACHE_DIR = cacheDir;
    renderedMarkdownCache.clear();
    forgetCacheIndex();
  });

  afterEach(async () => {
    if (previousCacheDir === undefined) {
      delete process.env.WIKI_MARKDOWN_CACHE_DIR;
    } else {
      process.env.WIKI_MARKDOWN_CACHE_DIR = previousCacheDir;
    }

    renderedMarkdownCache.clear();
    forgetCacheIndex();
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("renders sanitized docs HTML with canonical heading data", async () => {
    const rendered = await renderMarkdownToHtml(
      [
        "## Adding Elements to Layouts",
        "",
        "[Home](/home)",
        "",
        "[Unsafe](//example.com/phishing)",
        "",
        "> [!INFO]",
        "> First line",
        "",
        "```ts",
        "const value = 42;",
        "```",
      ].join("\n"),
    );

    expect(rendered.headings).toEqual([
      {
        depth: 2,
        text: "Adding Elements to Layouts",
        slug: "adding-elements-to-layouts",
      },
    ]);
    expect(rendered.html).toContain('<h2 id="adding-elements-to-layouts">Adding Elements to Layouts');
    expect(rendered.html).toContain('href="/docs/en-US/home"');
    expect(rendered.html).toContain('href="#"');
    expect(rendered.html).toContain('<aside class="md-alert md-alert-info" data-alert="info">');
    expect(rendered.html).toContain('class="markdown-code-block-shell"');
    expect(rendered.html).toContain('aria-label="Copy code"');
  });

  it("persists rendered markdown by page, language, renderer version, and content hash", async () => {
    const first = await renderGitHubDocPageMarkdown({
      config,
      languageCode: "en-US",
      page: createPage("## First"),
    });
    const firstFiles = await listCacheFiles(cacheDir);
    renderedMarkdownCache.clear();

    const second = await renderGitHubDocPageMarkdown({
      config,
      languageCode: "en-US",
      page: createPage("## First"),
    });
    const secondFiles = await listCacheFiles(cacheDir);

    expect(first.renderedHtml).toBe(second.renderedHtml);
    expect(first.headings).toEqual(second.headings);
    expect(firstFiles).toHaveLength(1);
    expect(secondFiles).toEqual(firstFiles);

    const changed = await renderGitHubDocPageMarkdown({
      config,
      languageCode: "en-US",
      page: createPage("## Second"),
    });

    expect(changed.renderedHtml).toContain("Second");
    expect(await listCacheFiles(cacheDir)).toHaveLength(2);
  });

  describe("persistent cache index", () => {
    let pagesDir = "";
    let indexPath = "";

    const entryReads = (): string[] => reads.paths.filter((filePath) => path.dirname(filePath) === pagesDir);
    const indexReads = (): string[] => reads.paths.filter((filePath) => filePath === indexPath);
    const writeEntries = async (...entryKeys: string[]): Promise<void> => {
      for (const key of entryKeys) {
        await writePersistentRenderedMarkdown(key, { headings: [{ depth: 2, slug: "intro", text: "Intro" }], html: `<h2 id="intro">${key}</h2>` });
      }
    };

    beforeEach(() => {
      pagesDir = path.join(cacheDir, "pages");
      indexPath = path.join(cacheDir, "index.json");
      reads.paths.length = 0;
    });

    it("lists, finds, and deletes entries from its index without opening them, also after a restart", async () => {
      await writeEntries(keys.home, keys.guide, keys.other);
      reads.paths.length = 0;

      expect((await listPersistentRenderedMarkdownCacheEntries()).map((entry) => entry.key)).toEqual([keys.guide, keys.home, keys.other]);
      await expect(hasPersistentRenderedMarkdown(keys.home)).resolves.toBe(true);
      await expect(hasPersistentRenderedMarkdown("source-a|markdown-render|v|missing|en-us|4444")).resolves.toBe(false);
      expect(reads.paths).toEqual([]);

      await flushRenderedMarkdownCacheIndex();
      if (process.platform !== "win32") {
        expect((await stat(indexPath)).mode & 0o777).toBe(0o600);
      }
      forgetCacheIndex();
      reads.paths.length = 0;

      const sourceA = await listPersistentRenderedMarkdownCacheEntries("source-a|");
      expect(sourceA).toEqual([
        { headingCount: 1, htmlBytes: Buffer.byteLength(`<h2 id="intro">${keys.guide}</h2>`), key: keys.guide, savedAt: expect.any(String) },
        { headingCount: 1, htmlBytes: Buffer.byteLength(`<h2 id="intro">${keys.home}</h2>`), key: keys.home, savedAt: expect.any(String) },
      ]);
      await expect(deletePersistentRenderedMarkdownWhere((key) => key.startsWith("source-a|"))).resolves.toBe(2);
      expect(indexReads()).toHaveLength(1);
      expect(entryReads()).toEqual([]);
      expect(await readdir(pagesDir)).toEqual([entryFileName(keys.other)]);
      await expect(readPersistentRenderedMarkdown(keys.other)).resolves.toMatchObject({ html: `<h2 id="intro">${keys.other}</h2>` });
    });

    it("rebuilds a missing or corrupt index from the entry files", async () => {
      await writeEntries(keys.home, keys.guide, keys.other);
      await flushRenderedMarkdownCacheIndex();

      await rename(indexPath, path.join(cacheDir, "moved-index.json"));
      forgetCacheIndex();
      reads.paths.length = 0;
      expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(3);
      expect(entryReads()).toHaveLength(3);
      await flushRenderedMarkdownCacheIndex();
      expect((JSON.parse(await readFile(indexPath, "utf8")) as { entries: unknown[] }).entries).toHaveLength(3);

      await writeFile(indexPath, '{"version":1,"kind":"rendered-markdown-index","entries":[', "utf8");
      forgetCacheIndex();
      reads.paths.length = 0;
      expect((await listPersistentRenderedMarkdownCacheEntries()).map((entry) => entry.key)).toEqual([keys.guide, keys.home, keys.other]);
      expect(entryReads()).toHaveLength(3);
    });

    it("reconciles a stale index with the entry directory, reading only the files it does not know", async () => {
      await writeEntries(keys.home, keys.guide);
      await flushRenderedMarkdownCacheIndex();
      // Written after the last index write, as if the process stopped before persisting it.
      await writeEntries(keys.other);
      await rename(path.join(pagesDir, entryFileName(keys.guide)), path.join(cacheDir, "moved-entry.json"));
      forgetCacheIndex();
      reads.paths.length = 0;

      expect((await listPersistentRenderedMarkdownCacheEntries()).map((entry) => entry.key)).toEqual([keys.home, keys.other]);
      expect(entryReads()).toEqual([path.join(pagesDir, entryFileName(keys.other))]);
      await expect(hasPersistentRenderedMarkdown(keys.guide)).resolves.toBe(false);
    });

    it("indexes a cache directory written before it had an index, deleting files that are no entries", async () => {
      await mkdir(pagesDir, { recursive: true, mode: 0o700 });
      const writeLegacyEntry = async (fileName: string, key: string): Promise<void> => {
        const entry = { version: 1, kind: "rendered-markdown", key, rendererVersion: MARKDOWN_RENDER_VERSION, savedAt: "2026-05-04T10:00:00.000Z", html: `<p>${key}</p>`, headings: [] };
        await writeFile(path.join(pagesDir, fileName), `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      };
      await writeLegacyEntry(entryFileName(keys.home), keys.home);
      await writeLegacyEntry(entryFileName(keys.guide), keys.guide);
      // Stored under the name of another key, so it could never be served.
      await writeLegacyEntry(entryFileName("source-a|markdown-render|v|elsewhere|en-us|5555"), keys.other);
      const corrupt = `${"c".repeat(64)}.json`;
      await writeFile(path.join(pagesDir, corrupt), '{"version":1,"kind":"rendered', { encoding: "utf8", mode: 0o600 });
      const abandonedTemp = `${entryFileName(keys.home)}.${process.pid + 1}.1714816800000.${randomUUID()}.tmp`;
      const ownTemp = `${entryFileName(keys.guide)}.${process.pid}.1714816800000.${randomUUID()}.tmp`;
      await writeFile(path.join(pagesDir, abandonedTemp), "{", { encoding: "utf8", mode: 0o600 });
      await writeFile(path.join(pagesDir, ownTemp), "{", { encoding: "utf8", mode: 0o600 });

      expect(await listPersistentRenderedMarkdownCacheEntries()).toEqual([
        { headingCount: 0, htmlBytes: Buffer.byteLength(`<p>${keys.guide}</p>`), key: keys.guide, savedAt: "2026-05-04T10:00:00.000Z" },
        { headingCount: 0, htmlBytes: Buffer.byteLength(`<p>${keys.home}</p>`), key: keys.home, savedAt: "2026-05-04T10:00:00.000Z" },
      ]);
      expect((await readdir(pagesDir)).sort()).toEqual([entryFileName(keys.guide), entryFileName(keys.home), ownTemp].sort());
      await expect(readPersistentRenderedMarkdown(keys.home)).resolves.toEqual({ headings: [], html: `<p>${keys.home}</p>` });

      await flushRenderedMarkdownCacheIndex();
      forgetCacheIndex();
      reads.paths.length = 0;
      expect(await listPersistentRenderedMarkdownCacheEntries()).toHaveLength(2);
      expect(entryReads()).toEqual([]);
    });

    it("forgets an entry whose file disappeared once a read misses it", async () => {
      await writeEntries(keys.home);
      await listPersistentRenderedMarkdownCacheEntries();
      await rename(path.join(pagesDir, entryFileName(keys.home)), path.join(cacheDir, "moved-entry.json"));

      await expect(readPersistentRenderedMarkdown(keys.home)).resolves.toBeNull();
      await expect(hasPersistentRenderedMarkdown(keys.home)).resolves.toBe(false);
    });
  });
});
