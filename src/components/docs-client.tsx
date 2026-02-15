"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  fetchDocPage,
  fetchDocsTree,
  firstLeafPath,
  formatApiError,
  searchDocs,
  toAbsoluteDocPath,
} from "@/components/api";
import { Breadcrumbs, type BreadcrumbItem } from "@/components/breadcrumbs";
import { cn } from "@/components/cn";
import { DocsTree } from "@/components/docs-tree";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState, LoadingState } from "@/components/states";
import type { DocPage, DocSearchResult, DocTreeNode } from "@/components/types";

type DocsClientProps = {
  initialPath: string;
};

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

function prettySegment(segment: string): string {
  return decodeURIComponent(segment).replace(/[-_]/g, " ");
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

export function DocsClient({ initialPath }: DocsClientProps) {
  const router = useRouter();
  const [tree, setTree] = useState<DocTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [currentPath, setCurrentPath] = useState<string>(normalizePath(initialPath));
  const [page, setPage] = useState<DocPage | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<DocSearchResult[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const scrollToHashTarget = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const rawHash = window.location.hash;
    if (!rawHash || rawHash === "#") {
      return;
    }

    const targetId = decodeURIComponent(rawHash.slice(1));
    if (!targetId) {
      return;
    }

    const targetElement = document.getElementById(targetId);
    if (!targetElement) {
      return;
    }

    targetElement.scrollIntoView({ block: "start", behavior: "auto" });
    const headerHeightVar = getComputedStyle(document.documentElement).getPropertyValue("--header-height").trim();
    const headerHeight = Number.parseInt(headerHeightVar, 10);

    if (Number.isFinite(headerHeight) && headerHeight > 0) {
      window.scrollBy({ top: -(headerHeight + 12), left: 0, behavior: "auto" });
    }
  }, []);

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
    if (pageLoading || pageError || !page) {
      return;
    }

    const handle = window.requestAnimationFrame(() => {
      scrollToHashTarget();
    });

    return () => {
      window.cancelAnimationFrame(handle);
    };
  }, [pageLoading, pageError, page, scrollToHashTarget]);

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

  const breadcrumbItems = useMemo<BreadcrumbItem[]>(() => {
    const path = page?.path ?? currentPath;
    const segments = path.split("/").filter(Boolean);
    const items: BreadcrumbItem[] = [{ label: "Docs", href: "/docs" }];
    let runningPath = "";

    segments.forEach((segment, index) => {
      runningPath += `/${segment}`;
      items.push({
        label: prettySegment(segment),
        href: index === segments.length - 1 ? undefined : toDocsHref(runningPath),
      });
    });

    return items;
  }, [currentPath, page]);

  const onSelectPath = (path: string) => {
    const normalized = normalizePath(path);
    setCurrentPath(normalized);
    setSearchQuery("");
    setSearchResults([]);
    setSidebarOpen(false);
    router.push(toDocsHref(normalized));
  };

  return (
    <section className="docs-page">
      <button
        type="button"
        className="mobile-sidebar-button"
        onClick={() => setSidebarOpen((prev) => !prev)}
        aria-expanded={sidebarOpen}
        aria-controls="docs-sidebar-panel"
      >
        <MaterialIcon name={sidebarOpen ? "close" : "menu"} />
        <span>{sidebarOpen ? "Close navigation" : "Browse docs"}</span>
      </button>

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
            <LoadingState label="Loading documentation tree..." />
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
              searchQuery={searchQuery}
              searching={searching}
              searchResults={searchResults}
              onSearchQueryChange={setSearchQuery}
              onSelectPath={onSelectPath}
            />
          )}
        </div>

        <main className="docs-main" id="main-content" aria-hidden={sidebarOpen || undefined}>
          <Breadcrumbs items={breadcrumbItems} />

          {pageLoading ? <LoadingState label="Loading page..." /> : null}

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
            <>
              <header className="page-heading">
                <h1>{page.title}</h1>
                {page.description ? <p>{page.description}</p> : null}
              </header>

              <div className="metadata-row" aria-label="Page metadata">
                <span className="meta-item">
                  <MaterialIcon name="schedule" />
                  Updated: {formatDate(page.updatedAt)}
                </span>
                <span className="meta-item">
                  <MaterialIcon name="person" />
                  Author: {page.updatedBy || "Unknown"}
                </span>
              </div>

              {page.headings.length > 0 ? (
                <nav className="toc-panel" aria-label="Table of contents">
                  <p className="toc-title">On this page</p>
                  <ul className="toc-list">
                    {page.headings
                      .filter((heading) => heading.depth <= 3)
                      .map((heading) => (
                        <li key={heading.slug} style={{ marginInlineStart: `${(heading.depth - 1) * 10}px` }}>
                          <a href={`#${heading.slug}`}>{heading.text}</a>
                        </li>
                      ))}
                  </ul>
                </nav>
              ) : null}

              <MarkdownRenderer content={page.content} />
            </>
          ) : null}
        </main>
      </div>
    </section>
  );
}
