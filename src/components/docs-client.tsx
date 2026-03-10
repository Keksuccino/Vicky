"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  fetchDocPage,
  fetchDocsTree,
  firstLeafPath,
  formatApiError,
  searchDocs,
  toAbsoluteDocPath,
} from "@/components/api";
import { cn } from "@/components/cn";
import { copyTextToClipboard } from "@/components/copy-text";
import { DocsTree } from "@/components/docs-tree";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState } from "@/components/states";
import type { DocPage, DocSearchResult, DocTreeNode } from "@/components/types";

type DocsClientProps = {
  initialPath: string;
};

const COPIED_STATE_DURATION_MS = 1400;

function normalizePath(path: string): string {
  return toAbsoluteDocPath(path || "/");
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

  return parsed.toLocaleString();
}

function normalizeComparableText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function getHeadingTextForMatch(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".heading-anchor").forEach((node) => node.remove());
  return normalizeComparableText(clone.textContent ?? "");
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

export function DocsClient({ initialPath }: DocsClientProps) {
  const router = useRouter();
  const [tree, setTree] = useState<DocTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [currentPath, setCurrentPath] = useState<string>(normalizePath(initialPath));
  const [page, setPage] = useState<DocPage | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [markdownAssetsResolved, setMarkdownAssetsResolved] = useState(false);
  const lastInitialHashScrollKeyRef = useRef<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<DocSearchResult[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [pageCopied, setPageCopied] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);

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

    const candidateIds = [targetId, `user-content-${targetId}`];
    let targetElement: HTMLElement | null = null;

    for (const candidateId of candidateIds) {
      const candidate = document.getElementById(candidateId);
      if (candidate) {
        targetElement = candidate;
        break;
      }
    }

    if (!targetElement) {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(targetId) : targetId;
      const found =
        document.querySelector<HTMLElement>(`#${escaped}`) ||
        document.querySelector<HTMLElement>(`[id="${escaped}"]`) ||
        document.querySelector<HTMLElement>(`[id="user-content-${escaped}"]`);
      if (found) {
        targetElement = found;
      }
    }

    if (!targetElement) {
      const normalizedTarget = targetId.toLowerCase();
      const fallback = Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(
        (element) =>
          element.id.toLowerCase() === normalizedTarget || element.id.toLowerCase() === `user-content-${normalizedTarget}`,
      );
      if (fallback) {
        targetElement = fallback;
      }
    }

    if (!targetElement && page?.headings.length) {
      const headingMatch = page.headings.find((heading) => normalizeComparableText(heading.slug) === normalizeComparableText(targetId));
      if (headingMatch) {
        const expectedText = normalizeComparableText(headingMatch.text);
        const byText = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")).find(
          (headingElement) => {
            const headingText = getHeadingTextForMatch(headingElement);
            return headingText === expectedText || headingText.startsWith(expectedText);
          },
        );
        if (byText) {
          targetElement = byText;
        }
      }
    }

    if (!targetElement) {
      return false;
    }

    scrollToElement(targetElement);

    return true;
  }, [page?.headings]);

  useEffect(() => {
    setCurrentPath(normalizePath(initialPath));
  }, [initialPath]);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const nextTree = await fetchDocsTree();
      setTree(nextTree);
    } catch (error) {
      setTreeError(formatApiError(error));
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadPage = useCallback(async (path: string) => {
    setPageLoading(true);
    setPageError(null);

    try {
      const nextPage = await fetchDocPage(path);
      setPage(nextPage);
    } catch (error) {
      setPage(null);
      setPageError(formatApiError(error));
    } finally {
      setPageLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (!treeLoading && currentPath === "/") {
      const firstPath = firstLeafPath(tree);
      if (firstPath && firstPath !== currentPath) {
        setCurrentPath(firstPath);
        router.replace(toDocsHref(firstPath));
      }
    }
  }, [tree, treeLoading, currentPath, router]);

  useEffect(() => {
    if (!currentPath) {
      return;
    }
    void loadPage(currentPath);
  }, [currentPath, loadPage]);

  useEffect(() => {
    lastInitialHashScrollKeyRef.current = null;
  }, [currentPath]);

  useEffect(() => {
    setCopyMenuOpen(false);
    setPageCopied(false);
  }, [currentPath]);

  useEffect(() => {
    if (pageLoading || pageError || !page) {
      setMarkdownAssetsResolved(false);
      return;
    }

    setMarkdownAssetsResolved(false);

    let cancelled = false;
    let frameId: number | null = null;
    const removeListeners: Array<() => void> = [];

    const resolveAssets = () => {
      if (cancelled) {
        return;
      }
      setMarkdownAssetsResolved(true);
    };

    const trackMarkdownImages = () => {
      if (cancelled) {
        return;
      }

      const mainElement = document.getElementById("main-content");
      const markdownRoot = mainElement?.querySelector<HTMLElement>(".markdown-body");

      if (!markdownRoot) {
        frameId = window.requestAnimationFrame(() => {
          frameId = null;
          trackMarkdownImages();
        });
        return;
      }

      const markdownImages = Array.from(markdownRoot.querySelectorAll<HTMLImageElement>("img"));
      if (markdownImages.length === 0) {
        resolveAssets();
        return;
      }

      let pendingImages = 0;
      const onImageSettled = () => {
        pendingImages -= 1;
        if (pendingImages <= 0) {
          resolveAssets();
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
        resolveAssets();
      }
    };

    trackMarkdownImages();

    return () => {
      cancelled = true;

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      for (const removeListener of removeListeners) {
        removeListener();
      }
    };
  }, [pageLoading, pageError, page]);

  useEffect(() => {
    if (!page || !markdownAssetsResolved || pageLoading || pageError) {
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

    const frameId = window.requestAnimationFrame(() => {
      scrollToHashTarget();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [markdownAssetsResolved, pageLoading, pageError, page, scrollToHashTarget]);

  useEffect(() => {
    const onHashChange = () => {
      scrollToHashTarget();
    };

    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [scrollToHashTarget]);

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

      scrollToHashTarget();
    };

    mainElement.addEventListener("click", onClick);
    return () => {
      mainElement.removeEventListener("click", onClick);
    };
  }, [scrollToHashTarget, page?.slug]);

  useEffect(() => {
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
        const nextResults = await searchDocs(term, controller.signal);
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
  }, [searchQuery]);

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
    setSearchQuery("");
    setSearchResults([]);
    setSidebarOpen(false);
    const hash = anchor ? `#${encodeURIComponent(anchor)}` : "";
    router.push(`${toDocsHref(normalized)}${hash}`);
  };

  const pageReadyForDisplay = !pageLoading && !pageError && Boolean(page) && markdownAssetsResolved;
  const showPagePlaceholder = pageLoading || (!pageLoading && !pageError && Boolean(page) && !markdownAssetsResolved);
  const rawPageHref = page ? toRawDocsHref(page.path) : null;
  const sidebarToggleButton = (
    <button
      type="button"
      className="mobile-sidebar-button ui-tooltip"
      onClick={() => setSidebarOpen((prev) => !prev)}
      aria-expanded={sidebarOpen}
      aria-controls="docs-sidebar-panel"
      aria-label={sidebarOpen ? "Close navigation" : "Browse docs"}
      data-ui-tooltip={sidebarOpen ? "Close navigation" : "Browse docs"}
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
            <div className={cn("docs-main-content", !pageReadyForDisplay && "docs-main-content-pending")} aria-hidden={!pageReadyForDisplay || undefined}>
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
    </section>
  );
}
