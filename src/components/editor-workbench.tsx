"use client";

import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  fetchAdminDocs,
  fetchDocPage,
  firstLeafPath,
  flattenTree,
  formatApiError,
  getCurrentUser,
  saveAdminDoc,
  toAbsoluteDocPath,
} from "@/components/api";
import { cn } from "@/components/cn";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MaterialIcon } from "@/components/material-icon";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useTheme } from "@/components/theme-provider";
import type { DocTreeNode, EditableDoc } from "@/components/types";

const INITIAL_DOC: EditableDoc = {
  title: "",
  description: "",
  path: "/new-page",
  slug: "new-page",
  content: "# Start writing\n\nDescribe this page.",
  includeInPlaintextExport: true,
  commitMessage: "docs: update new page",
};

type EditorTreeNodeProps = {
  node: DocTreeNode;
  currentPath: string;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (path: string) => void;
  level: number;
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function toSlug(path: string): string {
  if (!path || path === "/") {
    return "index";
  }

  return path.replace(/^\//, "");
}

function pathFromInput(input: string): string {
  const cleaned = input.trim();
  if (!cleaned) {
    return "/new-page";
  }

  if (cleaned.includes("/")) {
    return toAbsoluteDocPath(cleaned);
  }

  return toAbsoluteDocPath(slugify(cleaned));
}

function nodeMatchesFilter(node: DocTreeNode, query: string): boolean {
  const q = query.toLowerCase();
  if (!q) {
    return true;
  }

  if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
    return true;
  }

  return node.children.some((child) => nodeMatchesFilter(child, q));
}

function EditorTreeNode({ node, currentPath, expanded, onToggle, onSelect, level }: EditorTreeNodeProps) {
  const isExpanded = expanded.has(node.id);
  const isActive = currentPath === toAbsoluteDocPath(node.path);

  return (
    <li>
      <div className={`tree-row ${isActive ? "tree-row-active" : ""}`} style={{ paddingInlineStart: `${12 + level * 14}px` }}>
        {node.isFolder ? (
          <button
            type="button"
            className="tree-toggle"
            aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
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
              onSelect(node.path);
            }
          }}
        >
          <MaterialIcon className="tree-icon" name={node.isFolder ? "folder" : "description"} />
          <span>{node.name}</span>
        </button>
      </div>

      {node.isFolder && isExpanded && node.children.length > 0 ? (
        <ul className="tree-list">
          {node.children.map((child) => (
            <EditorTreeNode
              key={child.id}
              node={child}
              currentPath={currentPath}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              level={level + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function EditorWorkbench() {
  const router = useRouter();
  const { mode } = useTheme();

  const [tree, setTree] = useState<DocTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [draft, setDraft] = useState<EditableDoc>(INITIAL_DOC);
  const [autoPath, setAutoPath] = useState(true);
  const [hasLoadedInitialDoc, setHasLoadedInitialDoc] = useState(false);
  const [pageLoading, setPageLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editorView, setEditorView] = useState<"markdown" | "preview">("markdown");

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);

    try {
      const currentUser = await getCurrentUser();
      if (!currentUser) {
        router.replace("/admin/login");
        return;
      }

      const data = await fetchAdminDocs();
      setTree(data);
    } catch (error) {
      setTreeError(formatApiError(error));
    } finally {
      setTreeLoading(false);
    }
  }, [router]);

  const loadPage = useCallback(async (path: string) => {
    const normalized = toAbsoluteDocPath(path);
    setPageLoading(true);
    setSaveError(null);
    setStatusMessage(null);

    try {
      const page = await fetchDocPage(normalized);
      setDraft({
        title: page.title,
        description: page.description,
        path: page.path,
        slug: toSlug(page.path),
        content: page.content,
        includeInPlaintextExport: page.includeInPlaintextExport,
        commitMessage: `docs: update ${page.slug}`,
      });
      setAutoPath(false);
    } catch (error) {
      setSaveError(formatApiError(error));
    } finally {
      setPageLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (hasLoadedInitialDoc || treeLoading || tree.length === 0) {
      return;
    }

    const firstPath = firstLeafPath(tree);
    if (firstPath) {
      setHasLoadedInitialDoc(true);
      void loadPage(firstPath);
    }
  }, [hasLoadedInitialDoc, loadPage, tree, treeLoading]);

  const filteredTree = useMemo(() => {
    if (!searchTerm.trim()) {
      return tree;
    }

    return tree.filter((node) => nodeMatchesFilter(node, searchTerm.trim()));
  }, [searchTerm, tree]);

  const flatNodes = useMemo(() => flattenTree(tree).filter((node) => !node.isFolder), [tree]);

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

  const handleSaveDraft = useCallback(async () => {
    if (saveLoading) {
      return;
    }

    setSaveLoading(true);
    setStatusMessage(null);
    setSaveError(null);

    const normalizedPath = toAbsoluteDocPath(pathFromInput(draft.path || draft.slug));
    const commitMessage = draft.commitMessage.trim() || `docs: update ${toSlug(normalizedPath)}`;

    try {
      const saved = await saveAdminDoc({
        ...draft,
        path: normalizedPath,
        slug: toSlug(normalizedPath),
        commitMessage,
      });

      setDraft({
        title: saved.title,
        description: saved.description,
        path: saved.path,
        slug: saved.slug,
        content: saved.content,
        includeInPlaintextExport: saved.includeInPlaintextExport,
        commitMessage,
      });
      setStatusMessage(`Saved ${saved.path}.`);
      await loadTree();
    } catch (error) {
      setSaveError(formatApiError(error));
    } finally {
      setSaveLoading(false);
    }
  }, [draft, loadTree, saveLoading]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s";
      if (!isSaveShortcut) {
        return;
      }

      event.preventDefault();
      void handleSaveDraft();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleSaveDraft]);

  return (
    <section className="editor-page" id="main-content">
      <div className="editor-topbar">
        <div>
          <h1>Docs editor</h1>
          <p>Write markdown and commit directly to your docs repository.</p>
        </div>

        <div className="editor-topbar-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setDraft(INITIAL_DOC);
              setAutoPath(true);
              setStatusMessage("Started a new page draft.");
              setSaveError(null);
            }}
          >
            <MaterialIcon name="note_add" />
            <span>New page</span>
          </button>

          <button
            type="button"
            className="btn btn-primary"
            disabled={saveLoading}
            onClick={() => {
              void handleSaveDraft();
            }}
          >
            <MaterialIcon name={saveLoading ? "sync" : "save"} />
            <span>{saveLoading ? "Saving..." : "Save draft"}</span>
          </button>
        </div>
      </div>

      <div className="editor-layout">
        <aside className="editor-sidebar">
          <label className="field-row" htmlFor="editor-search-pages">
            <span className="field-label">Load existing page</span>
            <div className="search-input-wrap">
              <MaterialIcon name="search" className="search-icon" />
              <input
                id="editor-search-pages"
                className="input"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search by title or path"
              />
            </div>
          </label>

          <label className="field-row" htmlFor="editor-page-select">
            <span className="field-label">Quick select</span>
            <select
              id="editor-page-select"
              className="input"
              value={flatNodes.some((node) => node.path === draft.path) ? draft.path : ""}
              onChange={(event) => {
                if (!event.target.value) {
                  return;
                }
                void loadPage(event.target.value);
              }}
            >
              <option value="">Select a page</option>
              {flatNodes.map((node) => (
                <option key={node.path} value={node.path}>
                  {node.path}
                </option>
              ))}
            </select>
          </label>

          {treeLoading ? <LoadingState label="Loading pages..." /> : null}
          {treeError ? (
            <ErrorState
              title="Unable to load pages"
              message={treeError}
              actionLabel="Retry"
              onAction={() => {
                void loadTree();
              }}
            />
          ) : null}

          {!treeLoading && !treeError && filteredTree.length === 0 ? (
            <EmptyState title="No pages found" message="Try a different search term." />
          ) : null}

          {!treeLoading && !treeError && filteredTree.length > 0 ? (
            <ul className="tree-list">
              {filteredTree.map((node) => (
                <EditorTreeNode
                  key={node.id}
                  node={node}
                  currentPath={draft.path}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelect={(path) => {
                    void loadPage(path);
                  }}
                  level={0}
                />
              ))}
            </ul>
          ) : null}
        </aside>

        <section className="editor-main">
          <div className="editor-fields">
            <label className="field-row" htmlFor="doc-title">
              <span className="field-label">Title</span>
              <input
                id="doc-title"
                className="input"
                value={draft.title}
                onChange={(event) => {
                  const nextTitle = event.target.value;
                  setDraft((prev) => {
                    if (!autoPath) {
                      return { ...prev, title: nextTitle };
                    }

                    const generated = slugify(nextTitle) || "untitled";
                    const path = toAbsoluteDocPath(generated);
                    return {
                      ...prev,
                      title: nextTitle,
                      path,
                      slug: toSlug(path),
                    };
                  });
                }}
              />
            </label>

            <label className="field-row" htmlFor="doc-description">
              <span className="field-label">Description</span>
              <input
                id="doc-description"
                className="input"
                value={draft.description}
                onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
              />
            </label>

            <label className="field-row" htmlFor="doc-path">
              <span className="field-label">Slug / path</span>
              <input
                id="doc-path"
                className="input"
                value={draft.path}
                onChange={(event) => {
                  const normalized = pathFromInput(event.target.value);
                  setAutoPath(false);
                  setDraft((prev) => ({
                    ...prev,
                    path: normalized,
                    slug: toSlug(normalized),
                  }));
                }}
              />
            </label>

            <label className="field-row" htmlFor="doc-commit-message">
              <span className="field-label">Commit message</span>
              <input
                id="doc-commit-message"
                className="input"
                value={draft.commitMessage}
                onChange={(event) => setDraft((prev) => ({ ...prev, commitMessage: event.target.value }))}
              />
            </label>

            <div className="field-row editor-toggle-field">
              <span className="field-label">AI plaintext export</span>
              <div className="editor-switch-row">
                <button
                  id="doc-include-in-plaintext-export"
                  type="button"
                  role="switch"
                  aria-checked={draft.includeInPlaintextExport}
                  aria-labelledby="doc-include-in-plaintext-export-label"
                  aria-describedby="doc-include-in-plaintext-export-hint"
                  className={cn("editor-switch", draft.includeInPlaintextExport && "editor-switch-active")}
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      includeInPlaintextExport: !prev.includeInPlaintextExport,
                    }))
                  }
                >
                  <span className="editor-switch-thumb" aria-hidden="true" />
                </button>
                <span id="doc-include-in-plaintext-export-label">
                  Include this page in <code>/docs.txt</code>
                </span>
              </div>
              <span className="field-hint" id="doc-include-in-plaintext-export-hint">
                Turn this off to exclude the current page from the AI-focused plaintext docs export.
              </span>
            </div>
          </div>

          <div className="editor-view-toggle" role="tablist" aria-label="Editor view">
            <button
              type="button"
              role="tab"
              aria-selected={editorView === "markdown"}
              className={cn("editor-view-button", editorView === "markdown" && "editor-view-button-active")}
              onClick={() => setEditorView("markdown")}
            >
              <MaterialIcon name="code" />
              <span>Markdown</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={editorView === "preview"}
              className={cn("editor-view-button", editorView === "preview" && "editor-view-button-active")}
              onClick={() => setEditorView("preview")}
            >
              <MaterialIcon name="visibility" />
              <span>Preview</span>
            </button>
          </div>

          <div className="editor-split">
            {editorView === "markdown" ? (
              <section className="editor-pane editor-pane-code" aria-label="Markdown editor">
                <div className="editor-pane-header">
                  <MaterialIcon name="code" />
                  <span>Markdown</span>
                </div>

                {pageLoading ? <LoadingState label="Loading selected page..." /> : null}

                <CodeMirror
                  value={draft.content}
                  height="100%"
                  extensions={[markdown(), EditorView.lineWrapping]}
                  theme={mode === "light" ? "light" : oneDark}
                  basicSetup={{
                    lineNumbers: true,
                    bracketMatching: true,
                    highlightActiveLine: true,
                    autocompletion: true,
                  }}
                  onChange={(value) => {
                    setDraft((prev) => ({ ...prev, content: value }));
                  }}
                />
              </section>
            ) : (
              <section className="editor-pane editor-pane-preview" aria-label="Live preview">
                <div className="editor-pane-header">
                  <MaterialIcon name="visibility" />
                  <span>Preview</span>
                </div>
                <MarkdownRenderer content={draft.content} />
              </section>
            )}
          </div>

          {statusMessage ? <p className="success-text">{statusMessage}</p> : null}
          {saveError ? <p className="error-text">{saveError}</p> : null}
        </section>
      </div>
    </section>
  );
}
