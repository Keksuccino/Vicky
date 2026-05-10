"use client";

import { useEffect, useRef } from "react";

import { copyTextToClipboard } from "@/components/copy-text";

type RenderedMarkdownProps = {
  html: string;
};

const COPIED_STATE_DURATION_MS = 1400;

const setCopyButtonState = (button: HTMLButtonElement, copied: boolean): void => {
  button.classList.toggle("markdown-code-copy-button-success", copied);
  button.setAttribute("aria-label", copied ? "Code copied" : "Copy code");

  const icon = button.querySelector<HTMLElement>(".markdown-code-copy-icon");
  if (icon) {
    icon.classList.toggle("material-icon-filled", copied);
    icon.textContent = copied ? "check_circle" : "content_copy";
  }
};

export function RenderedMarkdown({ html }: RenderedMarkdownProps) {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const resetTimers = new Map<HTMLButtonElement, number>();

    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const button = target.closest<HTMLButtonElement>(".markdown-code-copy-button");
      if (!button || !root.contains(button)) {
        return;
      }

      const shell = button.closest<HTMLElement>(".markdown-code-block-shell");
      const codeText = shell?.querySelector("pre")?.textContent?.replace(/\n$/, "") ?? "";
      if (!codeText) {
        return;
      }

      event.preventDefault();

      void copyTextToClipboard(codeText).then((copied) => {
        if (!copied) {
          return;
        }

        setCopyButtonState(button, true);

        const previousTimer = resetTimers.get(button);
        if (previousTimer !== undefined) {
          window.clearTimeout(previousTimer);
        }

        const nextTimer = window.setTimeout(() => {
          setCopyButtonState(button, false);
          resetTimers.delete(button);
        }, COPIED_STATE_DURATION_MS);
        resetTimers.set(button, nextTimer);
      });
    };

    root.addEventListener("click", handleClick);

    return () => {
      root.removeEventListener("click", handleClick);
      for (const timerId of resetTimers.values()) {
        window.clearTimeout(timerId);
      }
      resetTimers.clear();
    };
  }, [html]);

  return <article ref={rootRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
