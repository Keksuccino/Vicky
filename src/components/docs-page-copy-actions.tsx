"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/components/cn";
import { copyTextToClipboard } from "@/components/copy-text";
import { MaterialIcon } from "@/components/material-icon";

type DocsPageCopyActionsProps = {
  rawHref: string;
};

const COPIED_STATE_DURATION_MS = 1400;

export function DocsPageCopyActions({ rawHref }: DocsPageCopyActionsProps) {
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [pageCopied, setPageCopied] = useState(false);
  const copyMenuRef = useRef<HTMLDivElement | null>(null);

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
    const response = await fetch(rawHref, {
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "text/plain",
      },
    });

    if (!response.ok) {
      return;
    }

    const copied = await copyTextToClipboard(await response.text());
    if (!copied) {
      return;
    }

    setPageCopied(true);
    setCopyMenuOpen(false);
  }, [rawHref]);

  return (
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

          <a className="page-copy-menu-item" role="menuitem" href={rawHref} onClick={() => setCopyMenuOpen(false)}>
            <MaterialIcon name="description" />
            <span>Open Markdown</span>
          </a>
        </div>
      ) : null}
    </div>
  );
}
