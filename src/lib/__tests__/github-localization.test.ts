import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docsSearchCorpusCache, docsSourceCache, getDocsCacheTtlMs, renderedMarkdownCache, setDocsCacheTtlMs } from "@/lib/cache";
import { DEFAULT_STORE } from "@/lib/defaults";
import { searchDocsCorpus } from "@/lib/docs-search";
import { loadDocsPageForLanguage, loadDocsTreeForLanguage, loadRenderedDocsPageForLanguage } from "@/lib/docs-server-data";
import { listMarkdownDocsTreePagesWithTitles, loadPublicGitHubDoc, refreshGitHubDocsCache } from "@/lib/github";
import { gitHubRuntimeCacheKey } from "@/lib/github-cache-identity";
import { clearGitHubBlobMemory } from "@/lib/github-content-store";
import { readPrivateJsonFile, sourceCacheFilePath } from "@/lib/github-docs-cache-files";
import { loadGitHubLocalizationStatuses } from "@/lib/github-localization";
import { saveGitHubLocalizedDoc, saveGitHubLocalizedDocsBatch } from "@/lib/github-localization-saves";
import { parseMarkdownDocument } from "@/lib/markdown";
import { createMarkdownRenderCacheStatus, warmMarkdownRenderCache } from "@/lib/markdown-render-cache-admin";
import { translatePageLocalizations, type PageLocalizationTranslationEvent } from "@/lib/page-localization";
import { getLatestPageLocalizationJob, startPageLocalizationJob } from "@/lib/page-localization-jobs";
import type { AutoTranslateLanguage, DocsStore, GitHubRuntimeConfig } from "@/lib/types";

import { createFakeGitHub, gitBlobShaOf, type FakeGitHub } from "./fixtures/fake-github-api";

const RUNTIME_DIRECTORY_VARIABLES = ["WIKI_DOCS_CACHE_DIR", "WIKI_MARKDOWN_CACHE_DIR", "WIKI_TRANSLATION_CACHE_DIR"] as const;

const SOURCE: AutoTranslateLanguage = { name: "English (US)", code: "en-US", icon: "us", enabled: true };
const GERMAN: AutoTranslateLanguage = { name: "German", code: "de", icon: "de", enabled: true };
const FRENCH: AutoTranslateLanguage = { name: "French", code: "fr", icon: "fr", enabled: true };

const createConfig = (): GitHubRuntimeConfig => ({ owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: "token", cacheEpoch: randomUUID() });

const createStore = (): DocsStore => {
  const store = DEFAULT_STORE();
  store.settings.autoTranslate.languages = [SOURCE, GERMAN, FRENCH];
  store.settings.autoTranslate.localizationPath = "localizations";
  return store;
};

const page = (title: string, body: string): string => `---\ntitle: ${title}\n---\n${body}`;

/** A translation that records the source version it was made from. */
const recordedTranslation = (title: string, body: string, sourceMarkdown: string): string => `---\ntitle: ${title}\nsourceBlobSha: ${gitBlobShaOf(sourceMarkdown)}\n---\n${body}`;

/** Routes OpenRouter requests to a canned translation and everything else to the fake GitHub API. */
const withFakeOpenRouter = (fake: FakeGitHub, translation: { title: string; description: string; content: string }) => {
  const openRouterRequests: unknown[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).startsWith("https://openrouter.ai/")) {
      openRouterRequests.push(JSON.parse(String(init?.body)));
      const content = JSON.stringify([{ page_display_name: translation.title, page_description: translation.description, page_content: translation.content }]);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fake.fetch(input, init);
  });
  return openRouterRequests;
};

/** Forgets everything held in memory, like a process restart; the persistent cache stays. */
const simulateRestart = (): void => {
  docsSourceCache.clear();
  docsSearchCorpusCache.clear();
  renderedMarkdownCache.clear();
  clearGitHubBlobMemory();
};

const treeNames = (items: Array<{ slug: string; name: string }>): Record<string, string> => Object.fromEntries(items.map((item) => [item.slug, item.name]));

describe("GitHub localizations from the repository index", () => {
  const previousEnvironment = new Map(RUNTIME_DIRECTORY_VARIABLES.map((name) => [name, process.env[name]]));
  const previousTtlMs = getDocsCacheTtlMs();
  let fake: FakeGitHub;
  let tempDir = "";
  let config: GitHubRuntimeConfig;
  let store: DocsStore;

  /** Resolves once the commit metadata looked up so far is on disk, so a simulated restart keeps it. */
  const waitForPersistedMetadata = async (repoPath: string): Promise<void> => {
    const filePath = sourceCacheFilePath(path.join(tempDir, "docs-cache"), gitHubRuntimeCacheKey(config), "commit-metadata");
    await vi.waitFor(async () => expect(JSON.stringify(await readPrivateJsonFile(filePath))).toContain(repoPath));
  };

  /** Lets the background language load finish and returns the complete sidebar. */
  const loadCompleteTree = async (languageCode: string) => {
    const tree = await loadDocsTreeForLanguage({ config, requestedLanguageCode: languageCode, store, waitForPendingTitles: true });
    expect(tree.titlesPending).toBe(false);
    return tree;
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-localization-"));
    process.env.WIKI_DOCS_CACHE_DIR = path.join(tempDir, "docs-cache");
    process.env.WIKI_MARKDOWN_CACHE_DIR = path.join(tempDir, "markdown");
    process.env.WIKI_TRANSLATION_CACHE_DIR = path.join(tempDir, "translations");
    simulateRestart();
    setDocsCacheTtlMs(3_600_000);
    config = createConfig();
    store = createStore();
    fake = createFakeGitHub();
    fake.setFile("docs/home.md", page("Home", "Welcome home"));
    fake.setFile("docs/guide/setup.md", page("Setup", "Install the package"));
    fake.setFile("docs/guide/usage.md", page("Usage", "Use it"));
    fake.setFile("localizations/de/home.md", page("Startseite", "Willkommen daheim"));
    fake.setFile("localizations/de/guide/setup.md", page("Einrichtung", "Installiere das Paket"));
    fake.setFile("localizations/de/orphan.md", page("Verwaist", "Keine Quellseite"));
    fake.setFile("localizations/fr/home.md", page("Accueil", "Bienvenue"));
    vi.stubGlobal("fetch", fake.fetch);
    await refreshGitHubDocsCache(config);
    fake.resetRequests();
  });

  afterEach(async () => {
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

  it("downloads a translated page once and then serves it without requests, also after a restart", async () => {
    const first = await loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store });

    expect(first.data).toMatchObject({ title: "Startseite", content: "Willkommen daheim", localizationStatus: "current", sourceLanguage: false, sourceHeadings: [] });
    expect(first.contentLanguageCode).toBe("de");
    expect(fake.count("blob")).toBe(1);
    expect(fake.count("graphql")).toBe(1);
    expect(fake.count()).toBe(2);

    fake.resetRequests();
    await expect(loadRenderedDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({ data: { title: "Startseite" } });
    expect(fake.count()).toBe(0);

    await waitForPersistedMetadata("localizations/de/home.md");
    simulateRestart();
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({ data: { title: "Startseite" } });
    expect(fake.count()).toBe(0);
  });

  it("falls back to the source page for a missing translation, an unknown language, or an unknown page without any request", async () => {
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "guide/usage" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({
      contentLanguageCode: "en-US",
      data: { title: "Usage", localizationStatus: "missing", sourceLanguage: true },
    });
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "xx", store })).resolves.toMatchObject({ data: { title: "Home" } });
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "orphan" }, requestedLanguageCode: "de", store })).rejects.toMatchObject({ status: 404 });

    expect(fake.count()).toBe(0);
  });

  it("falls back to the source page for an outdated translation", async () => {
    fake.setFile("docs/home.md", page("Home", "Welcome back"));
    await refreshGitHubDocsCache(config);

    await expect(loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({
      contentLanguageCode: "en-US",
      data: { content: "Welcome back", localizationStatus: "outdated", sourceLanguage: true, translationStale: true },
    });
    expect(treeNames((await loadCompleteTree("de")).data)).toEqual({ "guide/setup": "Einrichtung", "guide/usage": "Usage", home: "Home" });
  });

  it("serves a translation that records the current source version even when the source was committed after it", async () => {
    const home = page("Home", "Welcome home");
    fake.setFile("localizations/de/home.md", recordedTranslation("Startseite", "Willkommen daheim", home));
    // Committing the same content again gives the source a newer date but the same blob.
    fake.setFile("docs/home.md", home);
    await refreshGitHubDocsCache(config);

    await expect(loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({
      contentLanguageCode: "de",
      data: { title: "Startseite", localizationStatus: "current" },
    });
    expect(treeNames((await loadCompleteTree("de")).data)).toMatchObject({ home: "Startseite" });
  });

  it("treats a translation as outdated when its recorded source version differs, whatever the commit dates say", async () => {
    const previousHome = page("Home", "Welcome home");
    fake.setFile("docs/home.md", page("Home", "Welcome back"));
    // Committed after the source change, so the date rule alone would call it current.
    fake.setFile("localizations/de/home.md", recordedTranslation("Startseite", "Willkommen daheim", previousHome));
    await refreshGitHubDocsCache(config);

    await expect(loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({
      contentLanguageCode: "en-US",
      data: { content: "Welcome back", localizationStatus: "outdated", sourceLanguage: true },
    });
    expect(treeNames((await loadCompleteTree("de")).data)).toMatchObject({ home: "Home" });
    const statuses = await loadGitHubLocalizationStatuses({ config, languageCodes: ["de"], localizationPath: "localizations" });
    expect(statuses.get("de")?.get("home.md")).toMatchObject({ state: "outdated", summary: { sourceBlobSha: gitBlobShaOf(previousHome) } });
  });

  it("records the source version in a retranslated page and keeps the replaced translation's own keys", async () => {
    fake.setFile("localizations/de/home.md", "---\ntitle: Startseite\nreviewed_by: Lena\n---\nWillkommen daheim");
    const newHome = page("Home", "Welcome back");
    fake.setFile("docs/home.md", newHome);
    await refreshGitHubDocsCache(config);
    const { pages } = await listMarkdownDocsTreePagesWithTitles(config);
    const openRouterRequests = withFakeOpenRouter(fake, { title: "Startseite", description: "Erste Seite", content: "Willkommen zurück" });

    const result = await translatePageLocalizations({
      apiKey: "unused",
      config,
      languages: [GERMAN],
      localizationPath: "localizations",
      mode: "outdated",
      model: "unused",
      origin: "https://docs.example.com",
      siteTitle: "Docs",
      sourcePages: pages,
    });

    expect(result).toMatchObject({ requestedPages: 1, translatedPages: 1, failedPages: 0 });
    expect(openRouterRequests).toHaveLength(1);
    const replaced = fake.files.get("localizations/de/home.md")?.toString("utf8") ?? "";
    expect(replaced).toContain("reviewed_by: Lena");
    expect(parseMarkdownDocument(replaced)).toMatchObject({ title: "Startseite", content: "Willkommen zurück\n", sourceBlobSha: gitBlobShaOf(newHome) });
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({ data: { localizationStatus: "current" } });
  });

  it("keeps a translation's recorded source version and own keys when it is saved from fields", async () => {
    const home = page("Home", "Welcome home");
    fake.setFile("localizations/de/home.md", `---\ntitle: Startseite\nsourceBlobSha: ${gitBlobShaOf(home)}\nreviewed_by: Lena\n---\nWillkommen daheim`);
    await refreshGitHubDocsCache(config);
    const sourcePage = await loadPublicGitHubDoc(config, { slug: "home" });

    await saveGitHubLocalizedDoc({ config, language: GERMAN, localizationPath: "localizations", sourcePage, input: { title: "Startseite", content: "Willkommen zu Hause" } });

    const saved = fake.files.get("localizations/de/home.md")?.toString("utf8") ?? "";
    expect(saved).toContain("reviewed_by: Lena");
    expect(parseMarkdownDocument(saved)).toMatchObject({ content: "Willkommen zu Hause\n", sourceBlobSha: gitBlobShaOf(home) });
  });

  it("starts a translation job on a warm index with a single tree request", async () => {
    await loadGitHubLocalizationStatuses({ config, languageCodes: [GERMAN.code, FRENCH.code], localizationPath: "localizations" });
    fake.resetRequests();

    startPageLocalizationJob({
      apiKey: "unused",
      config,
      languages: [SOURCE, GERMAN, FRENCH],
      localizationPath: "localizations",
      mode: "outdated",
      model: "unused",
      origin: "https://docs.example.com",
      requestTimeoutMs: 60_000,
      siteTitle: "Docs",
    });

    await vi.waitFor(() => expect(getLatestPageLocalizationJob()?.status).toBe("completed"));
    expect(fake.requests.map((request) => request.kind)).toEqual(["tree"]);
  });

  it("stops serving deleted translations and translations of deleted source pages after the next refresh", async () => {
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({ data: { title: "Startseite" } });
    await loadCompleteTree("de");

    fake.deleteFile("localizations/de/home.md");
    fake.deleteFile("docs/guide/setup.md");
    await refreshGitHubDocsCache(config);

    await expect(loadDocsPageForLanguage({ config, locator: { slug: "home" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({ data: { title: "Home", localizationStatus: "missing" } });
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "guide/setup" }, requestedLanguageCode: "de", store })).rejects.toMatchObject({ status: 404 });
    expect(treeNames((await loadCompleteTree("de")).data)).toEqual({ "guide/usage": "Usage", home: "Home" });
  });

  it("answers the first sidebar of a language at once and fills in translated titles from one background load", async () => {
    const first = await loadDocsTreeForLanguage({ config, requestedLanguageCode: "de", store });

    expect(first.titlesPending).toBe(true);
    expect(treeNames(first.data)).toEqual({ "guide/setup": "Setup", "guide/usage": "Usage", home: "Home" });

    expect(treeNames((await loadCompleteTree("de")).data)).toEqual({ "guide/setup": "Einrichtung", "guide/usage": "Usage", home: "Startseite" });
    // Only the translations of source pages are loaded: the orphan is never downloaded.
    expect(fake.count("blob")).toBe(2);
    expect(fake.count("graphql")).toBe(1);
    expect(fake.count()).toBe(3);

    fake.resetRequests();
    await expect(loadDocsTreeForLanguage({ config, requestedLanguageCode: "de", store })).resolves.toMatchObject({ titlesPending: false });
    expect(fake.count()).toBe(0);

    await waitForPersistedMetadata("localizations/de/guide/setup.md");
    simulateRestart();
    const afterRestart = await loadDocsTreeForLanguage({ config, requestedLanguageCode: "de", store });
    expect(afterRestart.titlesPending).toBe(false);
    expect(treeNames(afterRestart.data)).toMatchObject({ "guide/setup": "Einrichtung", home: "Startseite" });
    expect(fake.count()).toBe(0);
  });

  it("returns translated search results once the language is stored, without further requests", async () => {
    const translation = { language: GERMAN, localizationPath: "localizations" };

    await vi.waitFor(async () => {
      await expect(searchDocsCorpus(config, "installiere", { translation })).resolves.toEqual([expect.objectContaining({ slug: "guide/setup", title: "Einrichtung" })]);
    });
    expect(fake.count("blob")).toBe(2);

    fake.resetRequests();
    await expect(searchDocsCorpus(config, "willkommen", { translation })).resolves.toEqual([expect.objectContaining({ slug: "home", title: "Startseite" })]);
    await expect(searchDocsCorpus(config, "use", { translation })).resolves.toEqual([expect.objectContaining({ slug: "guide/usage", title: "Usage" })]);
    expect(fake.count()).toBe(0);
  });

  it("computes the Markdown cache status without any request and downloads translations only to warm the cache", async () => {
    const cold = await createMarkdownRenderCacheStatus({ config, store });

    expect(fake.count()).toBe(0);
    expect(cold).toMatchObject({ totalPages: 3, totalVariants: 6, translatedVariants: 3, cachedVariants: 0 });

    const warmed = await warmMarkdownRenderCache({ config, store });
    expect(warmed).toMatchObject({ renderedVariants: 6, failedVariants: 0 });
    expect(fake.count("blob")).toBe(3);

    fake.resetRequests();
    await expect(createMarkdownRenderCacheStatus({ config, store })).resolves.toMatchObject({ cachedVariants: 6, uncachedVariants: 0, staleEntries: 0 });
    simulateRestart();
    await expect(createMarkdownRenderCacheStatus({ config, store })).resolves.toMatchObject({ cachedVariants: 6, uncachedVariants: 0 });
    await expect(warmMarkdownRenderCache({ config, store })).resolves.toMatchObject({ renderedVariants: 0, skippedVariants: 6 });
    expect(fake.count()).toBe(0);
  });

  it("computes the translation status of every language from the index and stored commit metadata", async () => {
    const { pages } = await listMarkdownDocsTreePagesWithTitles(config);
    await loadGitHubLocalizationStatuses({ config, languageCodes: [GERMAN.code, FRENCH.code], localizationPath: "localizations", sourcePages: pages });
    fake.resetRequests();

    const events: PageLocalizationTranslationEvent[] = [];
    await translatePageLocalizations({
      apiKey: "unused",
      config,
      languages: [GERMAN, FRENCH],
      localizationPath: "localizations",
      mode: "outdated",
      model: "unused",
      onEvent: (event) => events.push(event),
      origin: "https://docs.example.com",
      siteTitle: "Docs",
      sourcePages: pages,
    });

    expect(fake.count()).toBe(0);
    expect(events.find((event) => event.type === "prepared")).toMatchObject({
      statuses: [
        { languageCode: "de", currentPages: 2, missingPages: 1, outdatedPages: 0, unrecordedPages: 2 },
        { languageCode: "fr", currentPages: 1, missingPages: 2, outdatedPages: 0, unrecordedPages: 1 },
      ],
    });
  });

  it("serves a saved translation at once and needs only the tree request on the next refresh", async () => {
    const sourcePage = await loadPublicGitHubDoc(config, { slug: "guide/usage" });

    await saveGitHubLocalizedDoc({ config, language: GERMAN, localizationPath: "localizations", sourcePage, input: { markdown: page("Verwendung", "Benutze es") } });

    expect(fake.requests.map((request) => request.kind)).toEqual(["contents", "put-contents"]);
    fake.resetRequests();
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "guide/usage" }, requestedLanguageCode: "de", store })).resolves.toMatchObject({
      data: { title: "Verwendung", localizationStatus: "current", updatedBy: "Editor" },
    });
    expect(fake.count()).toBe(0);

    await refreshGitHubDocsCache(config);
    expect(fake.requests.map((request) => request.kind)).toEqual(["tree"]);
  });

  it("applies a batch of saved translations from the commit response", async () => {
    const [usage, setup] = await Promise.all([loadPublicGitHubDoc(config, { slug: "guide/usage" }), loadPublicGitHubDoc(config, { slug: "guide/setup" })]);

    await saveGitHubLocalizedDocsBatch({
      config,
      includePages: false,
      items: [
        { input: { markdown: page("Utilisation", "Utilisez-le") }, language: FRENCH, localizationPath: "localizations", sourcePage: usage },
        { input: { markdown: page("Installation", "Installez le paquet") }, language: FRENCH, localizationPath: "localizations", sourcePage: setup },
      ],
    });

    expect(fake.requests.map((request) => request.kind)).toEqual(["ref", "commit", "create-blob", "create-blob", "create-tree", "create-commit", "update-ref"]);
    fake.resetRequests();
    const tree = await loadDocsTreeForLanguage({ config, requestedLanguageCode: "fr", store, waitForPendingTitles: true });
    expect(treeNames(tree.data)).toEqual({ "guide/setup": "Installation", "guide/usage": "Utilisation", home: "Accueil" });
    await expect(loadDocsPageForLanguage({ config, locator: { slug: "guide/usage" }, requestedLanguageCode: "fr", store })).resolves.toMatchObject({
      data: { title: "Utilisation", localizationStatus: "current", updatedBy: "Translator" },
    });
    // The French home page is the only translation the save did not provide.
    expect(fake.requests.map((request) => request.kind)).toEqual(["blob", "graphql"]);

    fake.resetRequests();
    await refreshGitHubDocsCache(config);
    expect(fake.requests.map((request) => request.kind)).toEqual(["tree"]);
  });
});
