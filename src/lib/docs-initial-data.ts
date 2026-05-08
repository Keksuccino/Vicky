import { cookies, headers } from "next/headers";

import { buildDocTree, firstLeafPath, toAbsoluteDocPath } from "@/components/api";
import type { DocPage, DocTreeNode } from "@/components/types";
import {
  AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { loadDocsPageForLanguage, loadDocsTreeForLanguage, type DocsPageWithSourceHeadings } from "@/lib/docs-server-data";
import { resolveRuntimeConfig } from "@/lib/github";
import { getStore } from "@/lib/store";

export type InitialDocsClientData = {
  initialTree?: DocTreeNode[];
  initialPage?: DocPage | null;
  initialLanguageCode: string;
  initialTreeLanguageCode?: string;
  initialPageLanguageCode?: string;
};

const firstHeaderValue = (value: string | null): string => value?.split(",")[0]?.trim() ?? "";

const defaultProtocolForHost = (host: string): "http" | "https" =>
  host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]") ? "http" : "https";

const resolveRequestOrigin = async (): Promise<string> => {
  try {
    const headerStore = await headers();
    const forwardedProto = firstHeaderValue(headerStore.get("x-forwarded-proto"));
    const forwardedHost = firstHeaderValue(headerStore.get("x-forwarded-host"));
    const host = forwardedHost || firstHeaderValue(headerStore.get("host"));

    if (!host) {
      return "http://localhost:3000";
    }

    return `${forwardedProto || defaultProtocolForHost(host)}://${host}`;
  } catch {
    return "http://localhost:3000";
  }
};

const readRequestedLanguageCode = async (): Promise<string> => {
  try {
    const cookieStore = await cookies();
    return normalizeAutoTranslateLanguageCode(cookieStore.get(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)?.value);
  } catch {
    return "";
  }
};

const toClientDocPage = (page: DocsPageWithSourceHeadings): DocPage => ({
  title: page.title,
  description: page.description,
  path: toAbsoluteDocPath(page.slug),
  slug: page.slug,
  content: page.content,
  markdown: page.markdown,
  headings: page.headings,
  sourceHeadings: page.sourceHeadings,
  includeInPlaintextExport: page.includeInPlaintextExport,
  updatedAt: page.updatedAt,
  updatedBy: page.updatedBy,
});

export const loadInitialDocsClientData = async (requestedPath: string): Promise<InitialDocsClientData> => {
  const requestedLanguageCode = await readRequestedLanguageCode();
  const initialLanguageCode = requestedLanguageCode || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;

  try {
    const store = await getStore();
    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);
    const config = resolveRuntimeConfig(store.settings.github);
    const origin = await resolveRequestOrigin();
    const normalizedRequestedPath = toAbsoluteDocPath(requestedPath);

    let initialTree: DocTreeNode[] | undefined;
    let initialTreeLanguageCode: string | undefined;
    let initialPage: DocPage | null = null;
    let initialPageLanguageCode: string | undefined;
    let pagePath = normalizedRequestedPath;

    try {
      const treeResult = await loadDocsTreeForLanguage({
        config,
        origin,
        requestedLanguageCode,
        store,
      });
      initialTree = buildDocTree(treeResult.data);
      initialTreeLanguageCode = treeResult.language.code;

      if (pagePath === "/") {
        pagePath = firstLeafPath(initialTree) ?? "/";
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[docs] Failed to load initial docs tree: ${message}`);
    }

    if (pagePath !== "/") {
      try {
        const pageResult = await loadDocsPageForLanguage({
          config,
          locator: { slug: pagePath.replace(/^\/+/, "") },
          origin,
          requestedLanguageCode,
          store,
        });
        initialPage = toClientDocPage(pageResult.data);
        initialPageLanguageCode = pageResult.language.code;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[docs] Failed to load initial docs page: ${message}`);
      }
    }

    return {
      initialTree,
      initialPage,
      initialLanguageCode: initialPageLanguageCode ?? initialTreeLanguageCode ?? initialLanguageCode,
      initialTreeLanguageCode,
      initialPageLanguageCode,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[docs] Failed to prepare initial docs data: ${message}`);

    return {
      initialLanguageCode,
    };
  }
};
