"use client";

import { useMemo, useState } from "react";

import { cn } from "@/components/cn";
import { MaterialIcon } from "@/components/material-icon";
import { EmptyState } from "@/components/states";
import type { DocSearchResult, DocTreeNode, MarkdownHeading } from "@/components/types";

type SidebarView = "pages" | "content";

type DocsTreeProps = {
  tree: DocTreeNode[];
  currentPath: string;
  headings: MarkdownHeading[];
  searchQuery: string;
  searching: boolean;
  searchResults: DocSearchResult[];
  onSearchQueryChange: (value: string) => void;
  onSelectPath: (path: string, anchor?: string) => void;
};

type TreeNodeProps = {
  node: DocTreeNode;
  currentPath: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelectPath: (path: string, anchor?: string) => void;
  level: number;
};

function normalizePath(path: string): string {
  if (!path || path === "/") {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function TreeNode({ node, currentPath, expanded, onToggle, onSelectPath, level }: TreeNodeProps) {
  const isExpanded = expanded.has(node.id);
  const normalizedCurrent = normalizePath(currentPath);
  const normalizedPath = normalizePath(node.path);
  const isActive = normalizedCurrent === normalizedPath;

  return (
    <li>
      <div
        className={cn("tree-row", isActive && "tree-row-active")}
        style={{ paddingInlineStart: `${12 + level * 14}px` }}
      >
        {node.isFolder ? (
          <button
            type="button"
            aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className="tree-toggle"
            onClick={() => onToggle(node.id)}
          >
            <MaterialIcon name={isExpanded ? "expand_more" : "chevron_right"} />
          </button>
        ) : (
          <span className="tree-toggle tree-toggle-placeholder" aria-hidden="true" />
        )}

        <button
          type="button"
          className="tree-link"
          onClick={() => {
            if (node.isFolder) {
              onToggle(node.id);
            } else {
              onSelectPath(node.path);
            }
          }}
        >
          <MaterialIcon name={node.isFolder ? "folder" : "description"} className="tree-icon" />
          <span>{node.name}</span>
        </button>
      </div>

      {node.isFolder && isExpanded && node.children.length > 0 ? (
        <ul className="tree-list" role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              currentPath={currentPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelectPath={onSelectPath}
              level={level + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function DocsTree({
  tree,
  currentPath,
  headings,
  searchQuery,
  searching,
  searchResults,
  onSearchQueryChange,
  onSelectPath,
}: DocsTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sidebarView, setSidebarView] = useState<SidebarView>("pages");

  const hasSearch = searchQuery.trim().length > 0;
  const showTree = !hasSearch;

  const treeCount = useMemo(() => {
    const countNodes = (nodes: DocTreeNode[]): number =>
      nodes.reduce((acc, node) => acc + 1 + countNodes(node.children), 0);
    return countNodes(tree);
  }, [tree]);
  const tocHeadings = useMemo(() => headings.filter((heading) => heading.depth <= 4), [headings]);

  const onToggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <aside className="docs-sidebar" aria-label="Documentation navigation">
      <div className="docs-sidebar-top">
        <div className="sidebar-view-toggle" role="group" aria-label="Sidebar view">
          <button
            type="button"
            className={cn("sidebar-view-button", sidebarView === "pages" && "sidebar-view-button-active")}
            onClick={() => setSidebarView("pages")}
          >
            <MaterialIcon name="menu_book" />
            <span>Pages</span>
          </button>
          <button
            type="button"
            className={cn("sidebar-view-button", sidebarView === "content" && "sidebar-view-button-active")}
            onClick={() => setSidebarView("content")}
          >
            <MaterialIcon name="subject" />
            <span>Page Content</span>
          </button>
        </div>

        {sidebarView === "pages" ? (
          <>
            <div className="search-input-wrap">
              <MaterialIcon name="search" className="search-icon" />
              <input
                id="docs-search"
                className="input"
                aria-label="Search docs"
                placeholder="Find pages, headings, or keywords"
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
              />
            </div>
          </>
        ) : null}
      </div>

      {sidebarView === "pages" ? (
        showTree ? (
          tree.length > 0 ? (
            <div className="docs-tree-wrap">
              <p className="muted-caption">{treeCount} entries</p>
              <ul className="tree-list" role="tree">
                {tree.map((node) => (
                  <TreeNode
                    key={node.id}
                    node={node}
                    currentPath={currentPath}
                    expanded={expanded}
                    onToggle={onToggle}
                    onSelectPath={onSelectPath}
                    level={0}
                  />
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState title="No pages available" message="Docs tree is empty." />
          )
        ) : (
          <div className="search-results">
            <p className="muted-caption">Search results</p>
            {searching ? <p className="muted-caption">Searching...</p> : null}
            {!searching && searchResults.length === 0 ? (
              <EmptyState title="No matches" message="Try a different keyword." />
            ) : null}
            {searchResults.length > 0 ? (
              <ul className="result-list">
                {searchResults.map((result) => (
                  <li key={result.path}>
                    <button type="button" className="result-item" onClick={() => onSelectPath(result.path, result.anchor)}>
                      <strong>{result.title}</strong>
                      <span>{result.path}</span>
                      {result.excerpt ? <p>{result.excerpt}</p> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )
      ) : (
        <div className="sidebar-toc">
          {tocHeadings.length > 0 ? (
            <>
              <p className="muted-caption">{tocHeadings.length} headings</p>
              <nav aria-label="Page content">
                <ul className="sidebar-toc-list">
                  {tocHeadings.map((heading) => (
                    <li
                      key={heading.slug}
                      className="sidebar-toc-item"
                      style={{ paddingInlineStart: `${(heading.depth - 1) * 10}px` }}
                    >
                      <button
                        type="button"
                        className="sidebar-toc-link"
                        onClick={() => onSelectPath(currentPath, heading.slug)}
                      >
                        {heading.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            </>
          ) : (
            <EmptyState title="No headings found" message="This page does not have headings yet." />
          )}
        </div>
      )}
    </aside>
  );
}
