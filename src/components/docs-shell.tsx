"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";

import {
  fetchDocsTreeState,
  firstLeafPath,
  formatApiError,
  recordDisplayedDocPageVisit,
  searchDocs,
  toAbsoluteDocPath,
} from "@/components/api";
import { cn } from "@/components/cn";
import { DocsAiChat } from "@/components/docs-ai-chat";
import { DocsTree } from "@/components/docs-tree";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState } from "@/components/states";
import {
  AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT,
  AUTO_TRANSLATE_LANGUAGE_COOKIE_NAME,
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import { docsHrefForPagePath } from "@/lib/docs-routing";
import type { DocPageChrome, DocSearchResult, DocTreeNode, MarkdownHeading } from "@/components/types";

type DocsShellProps = {
  children: ReactNode;
  initialPath: string;
  initialTree?: DocTreeNode[];
  initialPage?: DocPageChrome | null;
  initialLanguageCode?: string;
  initialTreeLanguageCode?: string;
  initialTreeTitlesPending?: boolean;
  initialPageLanguageCode?: string;
};

const TREE_TITLES_REFRESH_DELAY_MS = 2500;
const MAX_TREE_TITLES_REFRESH_ATTEMPTS = 24;
const EMPTY_HEADINGS: MarkdownHeading[] = [];

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

function toDocsHref(path: string, languageCode?: string): string {
  return docsHrefForPagePath(path, languageCode);
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

function withInstantWindowScroll(scroll: () => void): void {
  const htmlBehavior = document.documentElement.style.scrollBehavior;
  const bodyBehavior = document.body.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = "auto";
  document.body.style.scrollBehavior = "auto";

  try {
    scroll();
  } finally {
    document.documentElement.style.scrollBehavior = htmlBehavior;
    document.body.style.scrollBehavior = bodyBehavior;
  }
}

function scrollToPageTop(): void {
  if (typeof window === "undefined") {
    return;
  }

  withInstantWindowScroll(() => {
    const scrollingElement = document.scrollingElement;
    if (scrollingElement) {
      scrollingElement.scrollTop = 0;
      scrollingElement.scrollLeft = 0;
    }

    document.documentElement.scrollTop = 0;
    document.documentElement.scrollLeft = 0;
    document.body.scrollTop = 0;
    document.body.scrollLeft = 0;
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
}

function scrollToElement(element: HTMLElement): void {
  const headerHeightVar = getComputedStyle(document.documentElement).getPropertyValue("--header-height").trim();
  const headerHeight = Number.parseInt(headerHeightVar, 10);
  const offset = Number.isFinite(headerHeight) && headerHeight > 0 ? headerHeight + 12 : 0;
  const top = Math.max(0, window.scrollY + element.getBoundingClientRect().top - offset);

  withInstantWindowScroll(() => {
    window.scrollTo({ top, left: 0, behavior: "auto" });
  });
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

export function DocsShell({
  children,
  initialPath,
  initialTree,
  initialPage,
  initialLanguageCode,
  initialTreeLanguageCode,
  initialTreeTitlesPending,
  initialPageLanguageCode,
}: DocsShellProps) {
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
  const [treeTitlesPending, setTreeTitlesPending] = useState(hasInitialTree ? Boolean(initialTreeTitlesPending) : false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>(initialDisplayPath);
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<DocSearchResult[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeHeadingSlug, setActiveHeadingSlug] = useState<string | null>(null);
  const [selectedLanguageCode, setSelectedLanguageCode] = useState(normalizedInitialLanguageCode);
  const [languageReady, setLanguageReady] = useState(Boolean(initialLanguageCode));
  const [pageTransitioning, setPageTransitioning] = useState(false);
  const treeLoadIdRef = useRef(0);
  const treeTitleRefreshAttemptsRef = useRef(0);
  const lastInitialHashScrollKeyRef = useRef<string | null>(null);
  const rootPathNeedsReplaceRef = useRef(normalizedInitialPath === "/" && initialDisplayPath !== "/");
  const loadedTreeLanguageRef = useRef<string | null>(hasInitialTree ? normalizedInitialTreeLanguageCode : null);
  const recordedVisitKeyRef = useRef<string | null>(null);
  const serverLanguageRef = useRef(normalizedInitialLanguageCode);
  const transitionTargetPathRef = useRef<string | null>(null);
  const page = hasInitialPage ? initialPage ?? null : null;
  const pageHeadings = pageTransitioning ? EMPTY_HEADINGS : page?.headings ?? EMPTY_HEADINGS;
  const sourceHeadings = pageTransitioning ? EMPTY_HEADINGS : page?.sourceHeadings ?? EMPTY_HEADINGS;

  useEffect(() => {
    serverLanguageRef.current = normalizedInitialLanguageCode;
    setSelectedLanguageCode(normalizedInitialLanguageCode);
  }, [normalizedInitialLanguageCode]);

  useEffect(() => {
    setLanguageReady(true);

    const onLanguageChange = (event: Event) => {
      const languageCode =
        event instanceof CustomEvent && typeof event.detail?.languageCode === "string"
          ? event.detail.languageCode
          : readSelectedLanguageCode();
      const normalized = normalizeAutoTranslateLanguageCode(languageCode) || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;

      setSelectedLanguageCode((current) => (current === normalized ? current : normalized));
      setLanguageReady(true);

      if (normalized !== serverLanguageRef.current) {
        transitionTargetPathRef.current = currentPath;
        flushSync(() => {
          setPageTransitioning(true);
          setSearchQuery("");
          setSearchResults([]);
          setSidebarOpen(false);
        });

        const hash = window.location.hash;
        router.push(`${toDocsHref(currentPath, normalized)}${hash}`, { scroll: false });
      }
    };

    window.addEventListener(AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT, onLanguageChange);
    return () => {
      window.removeEventListener(AUTO_TRANSLATE_LANGUAGE_CHANGE_EVENT, onLanguageChange);
    };
  }, [currentPath, router]);

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

    if (!targetElement && pageHeadings.length) {
      const headingMatch = pageHeadings.find((heading) => normalizeComparableText(heading.slug) === normalizeComparableText(targetId));
      if (headingMatch) {
        targetElement = findHeadingElement(headingMatch);
      }
    }

    if (!targetElement && sourceHeadings.length && pageHeadings.length) {
      const sourceHeadingIndex = sourceHeadings.findIndex(
        (heading) => normalizeComparableText(heading.slug) === normalizeComparableText(targetId),
      );
      const translatedHeading = sourceHeadingIndex >= 0 ? pageHeadings[sourceHeadingIndex] : null;
      if (translatedHeading) {
        targetElement = findHeadingElement(translatedHeading);
      }
    }

    if (!targetElement) {
      return false;
    }

    scrollToElement(targetElement);

    return true;
  }, [pageHeadings, sourceHeadings]);

  useEffect(() => {
    const nextInitialPath = normalizePath(initialPath);
    const nextDisplayPath = initialPage ? normalizePath(initialPage.path) : nextInitialPath;
    rootPathNeedsReplaceRef.current = nextInitialPath === "/" && nextDisplayPath !== "/";
    setCurrentPath(nextDisplayPath);

    if (!transitionTargetPathRef.current || transitionTargetPathRef.current === nextDisplayPath) {
      transitionTargetPathRef.current = null;
      setPageTransitioning(false);
    }
  }, [initialPath, initialPage]);

  const loadTree = useCallback(async (options?: { quiet?: boolean }) => {
    const quiet = Boolean(options?.quiet);
    const loadId = treeLoadIdRef.current + 1;
    treeLoadIdRef.current = loadId;
    if (!quiet) {
      setTreeLoading(true);
      setTreeError(null);
    }
    loadedTreeLanguageRef.current = null;
    try {
      const nextTreeResult = await fetchDocsTreeState(selectedLanguageCode, { waitForTitles: quiet });
      if (treeLoadIdRef.current !== loadId) {
        return;
      }
      setTree(nextTreeResult.tree);
      setTreeTitlesPending(nextTreeResult.titlesPending);
      if (!nextTreeResult.titlesPending) {
        treeTitleRefreshAttemptsRef.current = 0;
      }
      loadedTreeLanguageRef.current = selectedLanguageCode;
    } catch (error) {
      if (treeLoadIdRef.current !== loadId) {
        return;
      }
      if (!quiet) {
        setTreeError(formatApiError(error));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[docs] Failed to refresh docs tree titles: ${message}`);
      }
    } finally {
      if (treeLoadIdRef.current === loadId && !quiet) {
        setTreeLoading(false);
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
    treeTitleRefreshAttemptsRef.current = 0;
  }, [selectedLanguageCode]);

  useEffect(() => {
    if (!languageReady || treeLoading || treeError || !treeTitlesPending) {
      return;
    }

    if (treeTitleRefreshAttemptsRef.current >= MAX_TREE_TITLES_REFRESH_ATTEMPTS) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      treeTitleRefreshAttemptsRef.current += 1;
      void loadTree({ quiet: true });
    }, TREE_TITLES_REFRESH_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [languageReady, loadTree, treeError, treeLoading, treeTitlesPending]);

  useEffect(() => {
    if (rootPathNeedsReplaceRef.current && currentPath !== "/") {
      rootPathNeedsReplaceRef.current = false;
      router.replace(toDocsHref(currentPath, selectedLanguageCode), { scroll: false });
      return;
    }

    if (!treeLoading && currentPath === "/") {
      const firstPath = firstLeafPath(tree);
      if (firstPath && firstPath !== currentPath) {
        setCurrentPath(firstPath);
        router.replace(toDocsHref(firstPath, selectedLanguageCode), { scroll: false });
      }
    }
  }, [tree, treeLoading, currentPath, router, selectedLanguageCode]);

  useEffect(() => {
    lastInitialHashScrollKeyRef.current = null;
  }, [currentPath]);

  useEffect(() => {
    if (!page) {
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
  }, [page, scrollToHashTarget]);

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
    if (!page || normalizePath(page.path) !== currentPath) {
      return;
    }

    const visitKey = `${page.slug}::${normalizedInitialPageLanguageCode}`;
    if (!visitKey || recordedVisitKeyRef.current === visitKey) {
      return;
    }

    recordedVisitKeyRef.current = visitKey;
    void recordDisplayedDocPageVisit(page).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[visitors] Failed to queue docs page visit: ${message}`);
    });
  }, [currentPath, normalizedInitialPageLanguageCode, page]);

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

  const onSelectPath = (path: string, anchor?: string) => {
    const normalized = normalizePath(path);
    const hasAnchor = Boolean(anchor);
    const pageChanged = normalized !== currentPath;

    if (pageChanged) {
      transitionTargetPathRef.current = normalized;
      flushSync(() => {
        setPageTransitioning(true);
        setCurrentPath(normalized);
        setActiveHeadingSlug(null);
        setSearchQuery("");
        setSearchResults([]);
        setSidebarOpen(false);
      });
      scrollToPageTop();
    } else if (!hasAnchor) {
      scrollToPageTop();
    }

    if (!pageChanged) {
      setCurrentPath(normalized);
    }
    setActiveHeadingSlug(hasAnchor ? anchor ?? null : null);
    setSearchQuery("");
    setSearchResults([]);
    setSidebarOpen(false);
    const hash = hasAnchor ? `#${encodeURIComponent(anchor ?? "")}` : "";
    router.push(`${toDocsHref(normalized, selectedLanguageCode)}${hash}`, { scroll: false });
  };

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
              headings={pageHeadings}
              activeHeadingSlug={activeHeadingSlug}
              searchQuery={searchQuery}
              searching={searching}
              searchResults={searchResults}
              onSearchQueryChange={setSearchQuery}
              onSelectPath={onSelectPath}
            />
          )}
        </div>

        <main className="docs-main" id="main-content" aria-hidden={sidebarOpen || undefined} aria-busy={pageTransitioning || undefined}>
          {pageTransitioning ? <DocsPageUnresolved /> : children}
        </main>
      </div>

      <DocsAiChat />
    </section>
  );
}
