import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readPersistentTitleTranslationsSync,
  readPersistentTranslatedPageSync,
  writePersistentTitleTranslations,
  writePersistentTranslatedPage,
} from "@/lib/translation-cache-store";
import type { GitHubDocPage } from "@/lib/types";

const page: GitHubDocPage = {
  path: "home.md",
  slug: "home",
  sha: "translated-sha",
  title: "Startseite",
  description: "",
  content: "## Startseite",
  markdown: "## Startseite",
  headings: [{ depth: 2, text: "Startseite", slug: "startseite" }],
  includeInPlaintextExport: true,
};

describe.skipIf(process.platform === "win32")("translation cache permissions", () => {
  const previousCacheDir = process.env.WIKI_TRANSLATION_CACHE_DIR;
  let cacheDir = "";

  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(os.tmpdir(), "vicky-translation-permissions-"));
    process.env.WIKI_TRANSLATION_CACHE_DIR = cacheDir;
  });

  afterEach(async () => {
    if (previousCacheDir === undefined) {
      delete process.env.WIKI_TRANSLATION_CACHE_DIR;
    } else {
      process.env.WIKI_TRANSLATION_CACHE_DIR = previousCacheDir;
    }
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("writes private entries and repairs existing modes before synchronous reads", async () => {
    await expect(writePersistentTranslatedPage("page-key", page)).resolves.toBe(true);
    await expect(writePersistentTitleTranslations("title-key", new Map([["home", "Startseite"]]))).resolves.toBe(true);

    const pagesDir = path.join(cacheDir, "pages");
    const titlesDir = path.join(cacheDir, "titles");
    const pagePath = path.join(pagesDir, (await readdir(pagesDir))[0]);
    const titlesPath = path.join(titlesDir, (await readdir(titlesDir))[0]);
    await chmod(cacheDir, 0o755);
    await chmod(pagesDir, 0o755);
    await chmod(titlesDir, 0o755);
    await chmod(pagePath, 0o644);
    await chmod(titlesPath, 0o644);

    expect(readPersistentTranslatedPageSync("page-key")?.title).toBe("Startseite");
    expect(readPersistentTitleTranslationsSync("title-key")?.get("home")).toBe("Startseite");
    expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
    expect((await stat(pagesDir)).mode & 0o777).toBe(0o700);
    expect((await stat(titlesDir)).mode & 0o777).toBe(0o700);
    expect((await stat(pagePath)).mode & 0o777).toBe(0o600);
    expect((await stat(titlesPath)).mode & 0o777).toBe(0o600);
  });
});
