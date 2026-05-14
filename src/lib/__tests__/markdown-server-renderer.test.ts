import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderedMarkdownCache } from "@/lib/cache";
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
  });

  afterEach(async () => {
    if (previousCacheDir === undefined) {
      delete process.env.WIKI_MARKDOWN_CACHE_DIR;
    } else {
      process.env.WIKI_MARKDOWN_CACHE_DIR = previousCacheDir;
    }

    renderedMarkdownCache.clear();
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
});
