"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  fetchDocPage,
  fetchDocPageMetadata,
  fetchDocsTree,
  firstLeafPath,
  formatApiError,
  recordDisplayedDocPageVisit,
  searchDocs,
  toAbsoluteDocPath,
} from "@/components/api";
import { cn } from "@/components/cn";
import { copyTextToClipboard } from "@/components/copy-text";
import { DocsAiChat } from "@/components/docs-ai-chat";
import { DocsTree } from "@/components/docs-tree";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState } from "@/components/states";
import {
  AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT,
  AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import type { DocPage, DocSearchResult, DocTreeNode, MarkdownHeading } from "@/components/types";

type DocsClientProps = {
  initialPath: string;
  initialTree?: DocTreeNode[];
  initialPage?: DocPage | null;
  initialLanguageCode?: string;
  initialTreeLanguageCode?: string;
  initialPageLanguageCode?: string;
};

const COPIED_STATE_DURATION_MS = 1400;

function normalizePath(path: string): string {
  return toAbsoluteDocPath(path || "/");
}

function readCookie(name: string): string {
  if (typeof document === "undefined") {
    return "";
  }

  const prefix = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk.startsWith(prefix));

  return match ? decodeURIComponent(match.slice(prefix.length)) : "";
}

function readSelectedLanguageCode(): string {
  return normalizeAutoTranslateLanguageCode(readCookie(AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME)) || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;
}

function toDocsHref(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") {
    return "/docs";
  }
  return `/docs/${normalized.slice(1)}`;
}

function toRawDocsHref(path: string): string {
  const href = toDocsHref(path);
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}raw=1`;
}

function formatDate(value?: string): string {
  if (!value) {
    return "Unknown";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }

  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const hours = String(parsed.getUTCHours()).padStart(2, "0");
  const minutes = String(parsed.getUTCMinutes()).padStart(2, "0");
  const seconds = String(parsed.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
}

function normalizeComparableText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function decodeHashAnchor(hash: string): string | null {
  const rawAnchor = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!rawAnchor) {
    return null;
  }

  try {
    return decodeURIComponent(rawAnchor);
  } catch {
    return rawAnchor;
  }
}

function readCurrentHashAnchor(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return decodeHashAnchor(window.location.hash);
}

function getHeadingTextForMatch(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".heading-anchor").forEach((node) => node.remove());
  return normalizeComparableText(clone.textContent ?? "");
}

function findElementById(targetId: string): HTMLElement | null {
  const candidateIds = [targetId, `user-content-${targetId}`];

  for (const candidateId of candidateIds) {
    const candidate = document.getElementById(candidateId);
    if (candidate) {
      return candidate;
    }
  }

  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(targetId) : targetId;
  const found =
    document.querySelector<HTMLElement>(`#${escaped}`) ||
    document.querySelector<HTMLElement>(`[id="${escaped}"]`) ||
    document.querySelector<HTMLElement>(`[id="user-content-${escaped}"]`);
  if (found) {
    return found;
  }

  const normalizedTarget = targetId.toLowerCase();
  return (
    Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(
      (element) =>
        element.id.toLowerCase() === normalizedTarget || element.id.toLowerCase() === `user-content-${normalizedTarget}`,
    ) ?? null
  );
}

function findHeadingElement(heading: MarkdownHeading): HTMLElement | null {
  const byId = findElementById(heading.slug);
  if (byId) {
    return byId;
  }

  const expectedText = normalizeComparableText(heading.text);
  return (
    Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")).find((headingElement) => {
      const headingText = getHeadingTextForMatch(headingElement);
      return headingText === expectedText || headingText.startsWith(expectedText);
    }) ?? null
  );
}

function scrollToElement(element: HTMLElement): void {
  const headerHeightVar = getComputedStyle(document.documentElement).getPropertyValue("--header-height").trim();
  const headerHeight = Number.parseInt(headerHeightVar, 10);
  const offset = Number.isFinite(headerHeight) && headerHeight > 0 ? headerHeight + 12 : 0;
  const top = Math.max(0, window.scrollY + element.getBoundingClientRect().top - offset);

  // Force instant positioning to avoid racing with global smooth scroll behavior.
  const htmlBehavior = document.documentElement.style.scrollBehavior;
  const bodyBehavior = document.body.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = "auto";
  document.body.style.scrollBehavior = "auto";
  window.scrollTo({ top, left: 0, behavior: "auto" });
  document.documentElement.style.scrollBehavior = htmlBehavior;
  document.body.style.scrollBehavior = bodyBehavior;
}

function DocsSidebarUnresolved() {
  return (
    <aside className="docs-sidebar docs-sidebar-unresolved" aria-label="Documentation navigation" aria-busy="true">
      <div className="docs-sidebar-top">
        <div className="sidebar-view-toggle" aria-hidden="true">
          <span className="sidebar-view-button sidebar-skeleton-toggle-item" />
          <span className="sidebar-view-button sidebar-skeleton-toggle-item" />
        </div>
        <div className="sidebar-skeleton-input" aria-hidden="true" />
      </div>

      <div className="docs-tree-wrap" aria-hidden="true">
        <div className="sidebar-skeleton-caption" />
        <div className="sidebar-skeleton-list">
          <div className="sidebar-skeleton-row" />
          <div className="sidebar-skeleton-row" />
          <div className="sidebar-skeleton-row" />
          <div className="sidebar-skeleton-row" />
          <div className="sidebar-skeleton-row" />
        </div>
      </div>
    </aside>
  );
}

function DocsPageUnresolved() {
  return (
    <div className="docs-main-unresolved" role="status" aria-live="polite" aria-label="Loading page">
      <section className="page-header-card page-header-skeleton" aria-hidden="true">
        <div className="docs-skeleton-line docs-skeleton-heading" />
        <div className="docs-skeleton-line docs-skeleton-subheading" />
        <div className="docs-skeleton-meta-row">
          <div className="docs-skeleton-chip docs-skeleton-chip-long" />
          <div className="docs-skeleton-chip docs-skeleton-chip-short" />
        </div>
      </section>

      <div className="docs-markdown-skeleton" aria-hidden="true">
        <div className="docs-skeleton-line docs-skeleton-paragraph-wide" />
        <div className="docs-skeleton-line docs-skeleton-paragraph-wide" />
        <div className="docs-skeleton-line docs-skeleton-paragraph-mid" />
        <div className="docs-skeleton-line docs-skeleton-heading-small" />
        <div className="docs-skeleton-line docs-skeleton-paragraph-wide" />
        <div className="docs-skeleton-line docs-skeleton-paragraph-short" />
      </div>
    </div>
  );
}

export function DocsClient({
  initialPath,
  initialTree,
  initialPage,
  initialLanguageCode,
  initialTreeLanguageCode,
  initialPageLanguageCode,
}: DocsClientProps) {
  const router = useRouter();
  const normalizedInitialPath = normalizePath(initialPath);
  const normalizedInitialLanguageCode =
    normalizeAutoTranslateLanguageCode(initialLanguageCode) || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;
  const normalizedInitialTreeLanguageCode =
    normalizeAutoTranslateLanguageCode(initialTreeLanguageCode) || normalizedInitialLanguageCode;
  const normalizedInitialPageLanguageCode =
    normalizeAutoTranslateLanguageCode(initialPageLanguageCode) || normalizedInitialLanguageCode;
  const initialDisplayPath = initialPage ? normalizePath(initialPage.path) : normalizedInitialPath;
  const hasInitialTree = initialTree !== undefined && normalizedInitialTreeLanguageCode === normalizedInitialLanguageCode;
  const hasInitialPage =
    Boolean(initialPage) &&
    normalizedInitialPageLanguageCode === normalizedInitialLanguageCode &&
    normalizePath(initialPage?.path ?? "") === initialDisplayPath;
  const [tree, setTree] = useState<DocTreeNode[]>(hasInitialTree ? initialTree ?? [] : []);
  const [treeLoading, setTreeLoading] = useState(!hasInitialTree);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [currentPath, setCurrentPath] = useState<string>(initialDisplayPath);
  const [page, setPage] = useState<DocPage | null>(hasInitialPage ? initialPage ?? null : null);
  const [pageLoading, setPageLoading] = useState(!hasInitialPage);
  const [pageError, setPageError] = useState<string | null>(null);
  const lastInitialHashScrollKeyRef = useRef<string | null>(null);
  const rootPathNeedsReplaceRef = useRef(normalizedInitialPath === "/" && initialDisplayPath !== "/");

  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<DocSearchResult[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [pageCopied, setPageCopied] = useState(false);
  const [activeHeadingSlug, setActiveHeadingSlug] = useState<string | null>(null);
  const [selectedLanguageCode, setSelectedLanguageCode] = useState(normalizedInitialLanguageCode);
  const [languageReady, setLanguageReady] = useState(Boolean(initialLanguageCode));
  const treeLoadIdRef = useRef(0);
  const pageLoadIdRef = useRef(0);
  const metadataRequestKeyRef = useRef<string | null>(null);
  const loadedTreeLanguageRef = useRef<string | null>(hasInitialTree ? normalizedInitialTreeLanguageCode : null);
  const loadedPageKeyRef = useRef<string | null>(
    hasInitialPage && initialPage ? `${normalizePath(initialPage.path)}::${normalizedInitialPageLanguageCode}` : null,
  );
  const recordedVisitKeyRef = useRef<string | null>(null);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSelectedLanguageCode(readSelectedLanguageCode());
    setLanguageReady(true);

    const onLanguageChange = (event: Event) => {
      const languageCode =
        event instanceof CustomEvent && typeof event.detail?.languageCode === "string"
          ? event.detail.languageCode
          : readSelectedLanguageCode();
      const normalized = normalizeAutoTranslateLanguageCode(languageCode) || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;

      setSelectedLanguageCode((current) => (current === normalized ? current : normalized));
      setLanguageReady(true);
    };

    window.addEventListener(AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT, onLanguageChange);
    return () => {
      window.removeEventListener(AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT, onLanguageChange);
    };
  }, []);

  useEffect(() => {
    const mobileViewportQuery = window.matchMedia("(max-width: 900px)");

    const syncScrollLock = () => {
      const shouldLockScroll = sidebarOpen && mobileViewportQuery.matches;
      document.documentElement.classList.toggle("docs-scroll-locked", shouldLockScroll);
      document.body.classList.toggle("docs-scroll-locked", shouldLockScroll);
    };

    syncScrollLock();
    mobileViewportQuery.addEventListener("change", syncScrollLock);

    return () => {
      mobileViewportQuery.removeEventListener("change", syncScrollLock);
      document.documentElement.classList.remove("docs-scroll-locked");
      document.body.classList.remove("docs-scroll-locked");
    };
  }, [sidebarOpen]);

  const scrollToHashTarget = useCallback((): boolean => {
    if (typeof window === "undefined") {
      return false;
    }

    const rawHash = window.location.hash;
    if (!rawHash || rawHash === "#") {
      return false;
    }

    const targetId = decodeURIComponent(rawHash.slice(1));
    if (!targetId) {
      return false;
    }

    let targetElement = findElementById(targetId);

    if (!targetElement && page?.headings.length) {
      const headingMatch = page.headings.find((heading) => normalizeComparableText(heading.slug) === normalizeComparableText(targetId));
      if (headingMatch) {
        targetElement = findHeadingElement(headingMatch);
      }
    }

    if (!targetElement && page?.sourceHeadings?.length && page.headings.length) {
      const sourceHeadingIndex = page.sourceHeadings.findIndex(
        (heading) => normalizeComparableText(heading.slug) === normalizeComparableText(targetId),
      );
      const translatedHeading = sourceHeadingIndex >= 0 ? page.headings[sourceHeadingIndex] : null;
      if (translatedHeading) {
        targetElement = findHeadingElement(translatedHeading);
      }
    }

    if (!targetElement) {
      return false;
    }

    scrollToElement(targetElement);

    return true;
  }, [page?.headings, page?.sourceHeadings]);

  useEffect(() => {
    const nextInitialPath = normalizePath(initialPath);
    const nextDisplayPath = initialPage ? normalizePath(initialPage.path) : nextInitialPath;
    rootPathNeedsReplaceRef.current = nextInitialPath === "/" && nextDisplayPath !== "/";
    setCurrentPath(nextDisplayPath);
  }, [initialPath, initialPage]);

  const loadTree = useCallback(async () => {
    const loadId = treeLoadIdRef.current + 1;
    treeLoadIdRef.current = loadId;
    setTreeLoading(true);
    setTreeError(null);
    loadedTreeLanguageRef.current = null;
    try {
      const nextTree = await fetchDocsTree(selectedLanguageCode);
      if (treeLoadIdRef.current !== loadId) {
        return;
      }
      setTree(nextTree);
      loadedTreeLanguageRef.current = selectedLanguageCode;
    } catch (error) {
      if (treeLoadIdRef.current !== loadId) {
        return;
      }
      setTreeError(formatApiError(error));
    } finally {
      if (treeLoadIdRef.current === loadId) {
        setTreeLoading(false);
      }
    }
  }, [selectedLanguageCode]);

  const loadPage = useCallback(async (path: string) => {
    const loadId = pageLoadIdRef.current + 1;
    pageLoadIdRef.current = loadId;
    setPageLoading(true);
    setPageError(null);
    loadedPageKeyRef.current = null;

    try {
      const nextPage = await fetchDocPage(path, selectedLanguageCode);
      if (pageLoadIdRef.current !== loadId) {
        return;
      }
      setPage(nextPage);
      loadedPageKeyRef.current = `${normalizePath(nextPage.path)}::${selectedLanguageCode}`;
    } catch (error) {
      if (pageLoadIdRef.current !== loadId) {
        return;
      }
      setPage(null);
      setPageError(formatApiError(error));
    } finally {
      if (pageLoadIdRef.current === loadId) {
        setPageLoading(false);
      }
    }
  }, [selectedLanguageCode]);

  useEffect(() => {
    if (!languageReady) {
      return;
    }
    if (loadedTreeLanguageRef.current === selectedLanguageCode) {
      setTreeLoading(false);
      return;
    }
    void loadTree();
  }, [languageReady, loadTree, selectedLanguageCode]);

  useEffect(() => {
    if (rootPathNeedsReplaceRef.current && currentPath !== "/") {
      rootPathNeedsReplaceRef.current = false;
      router.replace(toDocsHref(currentPath));
      return;
    }

    if (!treeLoading && currentPath === "/") {
      const firstPath = firstLeafPath(tree);
      if (firstPath && firstPath !== currentPath) {
        setCurrentPath(firstPath);
        router.replace(toDocsHref(firstPath));
      }
    }
  }, [tree, treeLoading, currentPath, router]);

  useEffect(() => {
    if (!languageReady || !currentPath || currentPath === "/") {
      return;
    }
    if (loadedPageKeyRef.current === `${currentPath}::${selectedLanguageCode}`) {
      setPageLoading(false);
      return;
    }
    void loadPage(currentPath);
  }, [languageReady, currentPath, loadPage, selectedLanguageCode]);

  useEffect(() => {
    if (pageLoading || pageError || !page || (page.updatedAt && page.updatedBy)) {
      return;
    }

    const requestKey = `${page.slug}::${page.updatedAt ?? ""}::${page.updatedBy ?? ""}`;
    if (metadataRequestKeyRef.current === requestKey) {
      return;
    }

    metadataRequestKeyRef.current = requestKey;

    void fetchDocPageMetadata(page.path)
      .then((metadata) => {
        setPage((currentPage) => {
          if (!currentPage || currentPage.slug !== metadata.slug) {
            return currentPage;
          }

          const updatedAt = metadata.updatedAt ?? currentPage.updatedAt;
          const updatedBy = metadata.updatedBy ?? currentPage.updatedBy;
          if (currentPage.updatedAt === updatedAt && currentPage.updatedBy === updatedBy) {
            return currentPage;
          }

          return {
            ...currentPage,
            updatedAt,
            updatedBy,
          };
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[docs] Failed to load docs page metadata: ${message}`);
      })
      .finally(() => {
        if (metadataRequestKeyRef.current === requestKey) {
          metadataRequestKeyRef.current = null;
        }
      });
  }, [pageLoading, pageError, page]);

  useEffect(() => {
    lastInitialHashScrollKeyRef.current = null;
  }, [currentPath]);

  useEffect(() => {
    setCopyMenuOpen(false);
    setPageCopied(false);
  }, [currentPath]);

  useEffect(() => {
    if (pageLoading || pageError || !page) {
      return;
    }

    const initialHash = window.location.hash;
    if (!initialHash || initialHash === "#") {
      return;
    }

    const scrollKey = `${page.slug}::${initialHash}`;
    if (lastInitialHashScrollKeyRef.current === scrollKey) {
      return;
    }

    lastInitialHashScrollKeyRef.current = scrollKey;

    let correctionCancelled = false;
    let frameId: number | null = null;
    let ignoreScrollUntil = 0;
    const removeListeners: Array<() => void> = [];

    const canCorrectScroll = () => !correctionCancelled && window.location.hash === initialHash;

    const correctScroll = () => {
      if (!canCorrectScroll()) {
        return;
      }

      if (scrollToHashTarget()) {
        ignoreScrollUntil = performance.now() + 150;
      }
    };

    const cancelCorrection = () => {
      correctionCancelled = true;
    };

    const trackMarkdownImages = () => {
      if (!canCorrectScroll()) {
        return;
      }

      const mainElement = document.getElementById("main-content");
      const markdownRoot = mainElement?.querySelector<HTMLElement>(".markdown-body");

      if (!markdownRoot) {
        frameId = window.requestAnimationFrame(() => {
          frameId = null;
          correctScroll();
          trackMarkdownImages();
        });
        return;
      }

      const markdownImages = Array.from(markdownRoot.querySelectorAll<HTMLImageElement>("img"));
      if (markdownImages.length === 0) {
        return;
      }

      let pendingImages = 0;
      const onImageSettled = () => {
        pendingImages -= 1;
        if (pendingImages <= 0) {
          correctScroll();
        }
      };

      for (const image of markdownImages) {
        if (image.complete) {
          continue;
        }

        pendingImages += 1;
        const handleImageSettled = () => {
          image.removeEventListener("load", handleImageSettled);
          image.removeEventListener("error", handleImageSettled);
          onImageSettled();
        };

        image.addEventListener("load", handleImageSettled);
        image.addEventListener("error", handleImageSettled);
        removeListeners.push(() => {
          image.removeEventListener("load", handleImageSettled);
          image.removeEventListener("error", handleImageSettled);
        });
      }

      if (pendingImages === 0) {
        correctScroll();
      }
    };

    const onScroll = () => {
      if (performance.now() > ignoreScrollUntil) {
        cancelCorrection();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(event.key)) {
        cancelCorrection();
      }
    };

    window.addEventListener("wheel", cancelCorrection, { passive: true });
    window.addEventListener("touchstart", cancelCorrection, { passive: true });
    window.addEventListener("pointerdown", cancelCorrection, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("hashchange", cancelCorrection);

    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      correctScroll();
      trackMarkdownImages();
    });

    return () => {
      correctionCancelled = true;

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      for (const removeListener of removeListeners) {
        removeListener();
      }

      window.removeEventListener("wheel", cancelCorrection);
      window.removeEventListener("touchstart", cancelCorrection);
      window.removeEventListener("pointerdown", cancelCorrection);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("hashchange", cancelCorrection);
    };
  }, [pageLoading, pageError, page, scrollToHashTarget]);

  useEffect(() => {
    const onHashChange = () => {
      setActiveHeadingSlug(readCurrentHashAnchor());
      scrollToHashTarget();
    };

    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [scrollToHashTarget]);

  useEffect(() => {
    if (pageLoading || pageError || !page || normalizePath(page.path) !== currentPath) {
      return;
    }

    const visitKey = page.slug;
    if (!visitKey || recordedVisitKeyRef.current === visitKey) {
      return;
    }

    recordedVisitKeyRef.current = visitKey;
    void recordDisplayedDocPageVisit(page).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[visitors] Failed to queue docs page visit: ${message}`);
    });
  }, [currentPath, pageLoading, pageError, page]);

  useEffect(() => {
    setActiveHeadingSlug(readCurrentHashAnchor());
  }, [currentPath]);

  useEffect(() => {
    const mainElement = document.getElementById("main-content");
    if (!mainElement) {
      return;
    }

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const eventTarget = event.target;
      if (!(eventTarget instanceof Element)) {
        return;
      }

      const anchor = eventTarget.closest<HTMLAnchorElement>('a[href^="#"]');
      if (!anchor) {
        return;
      }

      const href = anchor.getAttribute("href");
      if (!href || href === "#") {
        return;
      }

      event.preventDefault();

      if (window.location.hash !== href) {
        window.history.pushState(null, "", href);
      }

      setActiveHeadingSlug(decodeHashAnchor(href));
      scrollToHashTarget();
    };

    mainElement.addEventListener("click", onClick);
    return () => {
      mainElement.removeEventListener("click", onClick);
    };
  }, [scrollToHashTarget, page?.slug]);

  useEffect(() => {
    if (!languageReady) {
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    let active = true;

    const handle = window.setTimeout(async () => {
      const term = searchQuery.trim();
      if (!term) {
        if (active) {
          setSearchResults([]);
          setSearching(false);
        }
        return;
      }

      if (active) {
        setSearching(true);
      }

      try {
        const nextResults = await searchDocs(term, controller.signal, selectedLanguageCode);
        if (!active) {
          return;
        }

        setSearchResults(nextResults);
      } catch {
        if (!active || controller.signal.aborted) {
          return;
        }

        setSearchResults([]);
      } finally {
        if (active) {
          setSearching(false);
        }
      }
    }, 250);

    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [languageReady, searchQuery, selectedLanguageCode]);

  useEffect(() => {
    if (!copyMenuOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Node) || copyMenuRef.current?.contains(eventTarget)) {
        return;
      }

      setCopyMenuOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCopyMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [copyMenuOpen]);

  useEffect(() => {
    if (!pageCopied) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setPageCopied(false);
    }, COPIED_STATE_DURATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [pageCopied]);

  const copyCurrentPageMarkdown = useCallback(async () => {
    if (!page) {
      return;
    }

    const copied = await copyTextToClipboard(page.markdown || page.content);
    if (!copied) {
      return;
    }

    setPageCopied(true);
    setCopyMenuOpen(false);
  }, [page]);

  const onSelectPath = (path: string, anchor?: string) => {
    const normalized = normalizePath(path);
    setCurrentPath(normalized);
    setActiveHeadingSlug(anchor ?? null);
    setSearchQuery("");
    setSearchResults([]);
    setSidebarOpen(false);
    const hash = anchor ? `#${encodeURIComponent(anchor)}` : "";
    router.push(`${toDocsHref(normalized)}${hash}`);
  };

  const showPagePlaceholder = pageLoading;
  const rawPageHref = page ? toRawDocsHref(page.path) : null;
  const sidebarToggleButton = (
    <button
      type="button"
      className="mobile-sidebar-button"
      onClick={() => setSidebarOpen((prev) => !prev)}
      aria-expanded={sidebarOpen}
      aria-controls="docs-sidebar-panel"
      aria-label={sidebarOpen ? "Close navigation" : "Browse docs"}
    >
      <span className="mobile-sidebar-button-surface" aria-hidden="true" />
      <MaterialIcon name={sidebarOpen ? "close" : "menu"} />
    </button>
  );

  return (
    <section className="docs-page">
      {sidebarToggleButton}

      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close documentation navigation"
          className="docs-sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <div className="docs-layout">
        <div
          id="docs-sidebar-panel"
          className={cn("docs-sidebar-panel", sidebarOpen && "docs-sidebar-open")}
          role={sidebarOpen ? "dialog" : undefined}
          aria-modal={sidebarOpen || undefined}
        >
          {treeLoading ? (
            <DocsSidebarUnresolved />
          ) : treeError ? (
            <ErrorState
              title="Unable to load docs tree"
              message={treeError}
              actionLabel="Retry"
              onAction={() => {
                void loadTree();
              }}
            />
          ) : (
            <DocsTree
              tree={tree}
              currentPath={currentPath}
              headings={page?.headings ?? []}
              activeHeadingSlug={activeHeadingSlug}
              searchQuery={searchQuery}
              searching={searching}
              searchResults={searchResults}
              onSearchQueryChange={setSearchQuery}
              onSelectPath={onSelectPath}
            />
          )}
        </div>

        <main className="docs-main" id="main-content" aria-hidden={sidebarOpen || undefined} aria-busy={showPagePlaceholder || undefined}>
          {showPagePlaceholder ? <DocsPageUnresolved /> : null}

          {pageError ? (
            <ErrorState
              title="Unable to load page"
              message={pageError}
              actionLabel="Retry"
              onAction={() => {
                void loadPage(currentPath);
              }}
            />
          ) : null}

          {!pageLoading && !pageError && page ? (
            <div className="docs-main-content">
              <section className="page-header-card" aria-label="Page header">
                <header className="page-heading">
                  <h1>{page.title}</h1>
                  {page.description ? <p>{page.description}</p> : null}
                </header>

                <div className="metadata-row" aria-label="Page metadata">
                  <div className="metadata-items">
                    <span className="meta-item">
                      <MaterialIcon name="schedule" />
                      Updated: {formatDate(page.updatedAt)}
                    </span>
                    <span className="meta-item">
                      <MaterialIcon name="person" />
                      Author: {page.updatedBy || "Unknown"}
                    </span>
                  </div>

                  <div className="page-copy-actions" ref={copyMenuRef}>
                    <div className="page-copy-button-group">
                      <button
                        type="button"
                        className={cn("page-copy-button", pageCopied && "page-copy-button-success")}
                        onClick={() => {
                          void copyCurrentPageMarkdown();
                        }}
                        aria-label={pageCopied ? "Page copied as markdown" : "Copy page as markdown"}
                      >
                        <MaterialIcon name={pageCopied ? "check_circle" : "content_copy"} filled={pageCopied} />
                        <span>Copy Page</span>
                      </button>

                      <button
                        type="button"
                        className="page-copy-menu-button"
                        aria-haspopup="menu"
                        aria-expanded={copyMenuOpen}
                        aria-label="Open page copy menu"
                        onClick={() => {
                          setCopyMenuOpen((previous) => !previous);
                        }}
                      >
                        <MaterialIcon name="arrow_drop_down" />
                      </button>
                    </div>

                    {copyMenuOpen ? (
                      <div className="page-copy-menu" role="menu" aria-label="Page copy options">
                        <button
                          type="button"
                          className="page-copy-menu-item"
                          role="menuitem"
                          onClick={() => {
                            void copyCurrentPageMarkdown();
                          }}
                        >
                          <MaterialIcon name="content_copy" />
                          <span>Copy as Markdown</span>
                        </button>

                        {rawPageHref ? (
                          <a className="page-copy-menu-item" role="menuitem" href={rawPageHref} onClick={() => setCopyMenuOpen(false)}>
                            <MaterialIcon name="description" />
                            <span>Open Markdown</span>
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>

              <MarkdownRenderer content={page.content} />
            </div>
          ) : null}
        </main>
      </div>

      <DocsAiChat />
    </section>
  );
}
