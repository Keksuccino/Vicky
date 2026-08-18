import { buildDocTree, firstLeafPath, toAbsoluteDocPath } from "@/components/api";
import type { DocPageChrome, DocTreeNode } from "@/components/types";
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
import { getStore } from "@/lib/store";

export type InitialDocsClientData = {
  initialPath?: string;
  initialTree?: DocTreeNode[];
  initialPage?: DocPageChrome | null;
  initialLanguageCode: string;
  initialTreeLanguageCode?: string;
  initialTreeTitlesPending?: boolean;
  initialPageLanguageCode?: string;
  page?: RenderedDocsPageWithSourceHeadings | null;
  pageError?: string;
};

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
    let pagePath = normalizedRequestedPath;

    if (pagePath === "/") {
      try {
        const treeResult = await loadDocsTreeForLanguage({
          config,
          requestedLanguageCode,
          store,
        });
        initialTree = buildDocTree(treeResult.data);
        initialTreeLanguageCode = treeResult.language.code;
        initialTreeTitlesPending = Boolean(treeResult.titlesPending);
        pagePath = firstLeafPath(initialTree) ?? "/";
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[docs] Failed to load initial docs tree: ${message}`);
      }
    }

    if (pagePath !== "/") {
      try {
        const pageResult = await loadRenderedDocsPageForLanguage({
          config,
          locator: { slug: pagePath.replace(/^\/+/, "") },
          requestedLanguageCode,
          store,
        });
        page = pageResult.data;
        initialPage = toClientDocPageChrome(pageResult.data);
        initialPageLanguageCode = pageResult.language.code;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        pageError = message;
        console.warn(`[docs] Failed to load initial docs page: ${message}`);
      }
    }

    return {
      initialPath: normalizedRequestedPath,
      initialTree,
      initialPage,
      initialLanguageCode: initialPageLanguageCode ?? initialTreeLanguageCode ?? initialLanguageCode,
      initialTreeLanguageCode,
      initialTreeTitlesPending,
      initialPageLanguageCode,
      page,
      pageError,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[docs] Failed to prepare initial docs data: ${message}`);

    return {
      initialPath: requestedPath,
      initialLanguageCode,
      pageError: message,
    };
  }
};
