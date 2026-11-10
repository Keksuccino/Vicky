import { buildDocTree, firstLeafPath, toAbsoluteDocPath } from "@/components/api";
import type { DocPageChrome, DocTreeNode } from "@/components/types";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
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
import { startPageToDocsHref } from "@/lib/start-page";
import { getStore } from "@/lib/store";

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

export const loadInitialDocsClientData = async (requestedPath: string): Promise<InitialDocsClientData> => {
  let initialLanguageCode = DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;

  try {
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const request = { headers: await headers() };
    const route = parseDocsRoutePath(requestedPath, store.settings.autoTranslate.languages);
    const requestedLanguageCode = route.languageCode || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;
    initialLanguageCode = requestedLanguageCode || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;
    const normalizedRequestedPath = toAbsoluteDocPath(route.pagePath);

    let initialTree: DocTreeNode[] | undefined;
    let initialTreeLanguageCode: string | undefined;
    let initialTreeTitlesPending = false;
    let initialPage: DocPageChrome | null = null;
    let initialPageLanguageCode: string | undefined;
    let page: RenderedDocsPageWithSourceHeadings | null = null;
    let pageError: string | undefined;
    let pageErrorStatus: number | undefined;
    let pagePath = normalizedRequestedPath;

    if (pagePath === "/") {
      try {
        const treeResult = await loadDocsTreeForLanguage({
          config,
          requestedLanguageCode,
          request,
          store,
        });
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
        const pageResult = await loadRenderedDocsPageForLanguage({
          config,
          locator: { slug: pagePath.replace(/^\/+/, "") },
          requestedLanguageCode,
          request,
          store,
        });
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
        initialPath: normalizedRequestedPath,
        initialTree,
        initialPage,
        initialLanguageCode: initialPageLanguageCode ?? initialTreeLanguageCode ?? initialLanguageCode,
        initialTreeLanguageCode,
        initialTreeTitlesPending,
        initialPageLanguageCode,
      },
      page,
      pageError,
      pageErrorStatus,
    };
  } catch (error: unknown) {
    const publicError = resolvePublicError(error, { context: "prepare initial docs data", fallbackMessage: PAGE_LOAD_FAILURE_MESSAGE });

    return {
      shell: {
        initialPath: requestedPath,
        initialLanguageCode,
      },
      pageError: publicError.message,
      pageErrorStatus: publicError.status,
    };
  }
};

/** Maps the optional catch-all `slug` param of `/docs/[[...slug]]` to the requested docs path. */
export const docsRequestPath = (slug: string[] | undefined): string => (slug?.length ? `/${slug.join("/")}` : "/");

const resolveStartPageHref = async (): Promise<string | null> => {
  try {
    return startPageToDocsHref((await getStore()).settings.startPage, DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE);
  } catch {
    // The initial-data load reads the store again and reports the failure inside the docs shell.
    return null;
  }
};

/**
 * Loads one docs route per request. The docs layout renders the shell from this data while the
 * page renders the article or interrupts with its not-found or error state, so both read the
 * same request-scoped result instead of loading (and consuming admission permits) twice. The
 * bare docs index has no document of its own and forwards to the configured start page.
 */
export const loadDocsRouteData = cache(async (requestedPath: string): Promise<InitialDocsClientData> => {
  if (requestedPath === "/") {
    const startPageHref = await resolveStartPageHref();
    if (startPageHref) {
      redirect(startPageHref);
    }
  }

  return loadInitialDocsClientData(requestedPath);
});
