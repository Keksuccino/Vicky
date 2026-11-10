import { buildDocTree, firstLeafPath, toAbsoluteDocPath } from "@/components/api";
import type { DocPageChrome, DocTreeNode } from "@/components/types";
import { headers } from "next/headers";
import { cache } from "react";
import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
} from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { parseDocsRoutePath } from "@/lib/docs-routing";
import {
  loadDocsTreeForLanguage,
  loadRenderedDocsPageForLanguage,
  type RenderedDocsPageWithSourceHeadings,
} from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
import { resolvePublicError } from "@/lib/http";
import { withPublicDocsAdmission } from "@/lib/public-docs-admission";
import { startPageToDocsHref } from "@/lib/start-page";
import { getStore } from "@/lib/store";
import type { DocsStore, GitHubRuntimeConfig } from "@/lib/types";

/** Initial props for the client docs shell (sidebar, navigation, and page chrome). */
export type DocsShellData = {
  initialPath?: string;
  initialTree?: DocTreeNode[];
  initialPage?: DocPageChrome | null;
  initialLanguageCode: string;
  initialTreeLanguageCode?: string;
  initialTreeTitlesPending?: boolean;
  initialPageLanguageCode?: string;
};

export type InitialDocsClientData = {
  shell: DocsShellData;
  page?: RenderedDocsPageWithSourceHeadings | null;
  pageError?: string;
  /** HTTP status describing why `page` is missing; unset when the page loaded. */
  pageErrorStatus?: number;
};

const PAGE_LOAD_FAILURE_MESSAGE = "The requested docs page could not be loaded.";

const toClientDocPageChrome = (page: RenderedDocsPageWithSourceHeadings): DocPageChrome => ({
  title: page.title,
  description: page.description,
  path: toAbsoluteDocPath(page.slug),
  slug: page.slug,
  headings: page.headings,
  sourceHeadings: page.sourceHeadings,
  includeInPlaintextExport: page.includeInPlaintextExport,
  updatedAt: page.updatedAt,
  updatedBy: page.updatedBy,
});

type RouteDocsInput = {
  config: GitHubRuntimeConfig;
  initialPath: string;
  languageCode: string;
  store: DocsStore;
};

/** Loads the page of one docs route, and for a docs root the tree to find its first page; failures become page errors. */
const loadRouteDocs = async ({ config, initialPath, languageCode, store }: RouteDocsInput): Promise<InitialDocsClientData> => {
  let initialTree: DocTreeNode[] | undefined;
  let initialTreeLanguageCode: string | undefined;
  let initialTreeTitlesPending = false;
  let initialPage: DocPageChrome | null = null;
  let initialPageLanguageCode: string | undefined;
  let page: RenderedDocsPageWithSourceHeadings | null = null;
  let pageError: string | undefined;
  let pageErrorStatus: number | undefined;
  let pagePath = initialPath;

  if (pagePath === "/") {
    try {
      const treeResult = await loadDocsTreeForLanguage({ config, requestedLanguageCode: languageCode, store });
      initialTree = buildDocTree(treeResult.data);
      initialTreeLanguageCode = treeResult.language.code;
      initialTreeTitlesPending = Boolean(treeResult.titlesPending);
      pagePath = firstLeafPath(initialTree) ?? "/";
    } catch (error: unknown) {
      pageErrorStatus = resolvePublicError(error, { context: "load initial docs tree" }).status;
    }
  }

  if (pagePath !== "/") {
    try {
      const pageResult = await loadRenderedDocsPageForLanguage({ config, locator: { slug: pagePath.replace(/^\/+/, "") }, requestedLanguageCode: languageCode, store });
      page = pageResult.data;
      initialPage = toClientDocPageChrome(pageResult.data);
      initialPageLanguageCode = pageResult.language.code;
    } catch (error: unknown) {
      const publicError = resolvePublicError(error, { context: "load initial docs page", fallbackMessage: PAGE_LOAD_FAILURE_MESSAGE });
      pageError = publicError.message;
      pageErrorStatus = publicError.status;
    }
  } else {
    // A docs root has no page to show: its tree failed to load or contains no document.
    pageError = PAGE_LOAD_FAILURE_MESSAGE;
    pageErrorStatus ??= 404;
  }

  return {
    shell: {
      initialPath,
      initialTree,
      initialPage,
      initialLanguageCode: initialPageLanguageCode ?? initialTreeLanguageCode ?? languageCode,
      initialTreeLanguageCode,
      initialTreeTitlesPending,
      initialPageLanguageCode,
    },
    page,
    pageError,
    pageErrorStatus,
  };
};

/** Initial data of one docs route. The whole render takes one public admission permit, even when a docs root loads its tree too. */
export const loadInitialDocsClientData = async (requestedPath: string): Promise<InitialDocsClientData> => {
  let initialLanguageCode = DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;
  let initialPath = requestedPath;

  try {
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const request = { headers: await headers() };
    const route = parseDocsRoutePath(requestedPath, store.settings.autoTranslate.languages);
    initialLanguageCode = route.languageCode || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;
    initialPath = toAbsoluteDocPath(route.pagePath);
    const input: RouteDocsInput = { config, initialPath, languageCode: initialLanguageCode, store };

    return await withPublicDocsAdmission(request, () => loadRouteDocs(input));
  } catch (error: unknown) {
    const publicError = resolvePublicError(error, { context: "prepare initial docs data", fallbackMessage: PAGE_LOAD_FAILURE_MESSAGE });

    return {
      shell: {
        initialPath,
        initialLanguageCode,
      },
      pageError: publicError.message,
      pageErrorStatus: publicError.status,
    };
  }
};

/** Maps the optional catch-all `slug` param of `/docs/[[...slug]]` to the requested docs path. */
export const docsRequestPath = (slug: string[] | undefined): string => (slug?.length ? `/${slug.join("/")}` : "/");

/**
 * Where the bare docs index forwards to: the configured start page, read once per request. The
 * index has no document of its own; the page forwards it (to the raw Markdown for `?raw`) before
 * anything loads, and the layout renders nothing for it. Null when the store cannot be read: the
 * index then loads like any route, which reports the failure inside the docs shell.
 */
export const resolveDocsIndexHref = cache(async (): Promise<string | null> => {
  try {
    return startPageToDocsHref((await getStore()).settings.startPage, DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE);
  } catch {
    return null;
  }
});

/**
 * Loads one docs route per request. The docs layout renders the shell from this data, the page
 * renders the article or interrupts with its not-found or error state, and `generateMetadata`
 * takes the title and description from it, so all three read the same request-scoped result
 * instead of loading (and consuming admission permits) more than once.
 */
export const loadDocsRouteData = cache((requestedPath: string): Promise<InitialDocsClientData> => loadInitialDocsClientData(requestedPath));
