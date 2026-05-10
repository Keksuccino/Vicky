"use client";

/* eslint-disable @next/next/no-img-element -- Markdown images can point to arbitrary remote hosts. */

import { isValidElement, useCallback, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "@/components/cn";
import { copyTextToClipboard } from "@/components/copy-text";
import {
  isSafeMarkdownHref,
  markdownAutolinkHeadingsOptions,
  markdownHighlightOptions,
  markdownSanitizeSchema,
  normalizeInternalDocsLink,
} from "@/lib/markdown-rendering-shared";
import { remarkGitHubAlerts } from "@/lib/remark-github-alerts";

type MarkdownRendererProps = {
  content: string;
};

const COPIED_STATE_DURATION_MS = 1400;

type CodeBlockProps = ComponentPropsWithoutRef<"pre">;

const getNodeText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getNodeText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getNodeText(node.props.children);
  }

  return "";
};

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const codeText = useMemo(() => getNodeText(children).replace(/\n$/, ""), [children]);

  const handleCopy = useCallback(async () => {
    if (!codeText) {
      return;
    }

    const copiedText = await copyTextToClipboard(codeText);
    if (copiedText) {
      setCopied(true);
    }
  }, [codeText]);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_STATE_DURATION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copied]);

  return (
    <div className="markdown-code-block-shell">
      <button
        type="button"
        className={cn("markdown-code-copy-button", copied && "markdown-code-copy-button-success")}
        onClick={handleCopy}
        aria-label={copied ? "Code copied" : "Copy code"}
      >
        <span className={cn("material-symbols-outlined", "markdown-code-copy-icon", copied && "material-icon-filled")}>
          {copied ? "check_circle" : "content_copy"}
        </span>
      </button>

      <pre className={cn("markdown-code-block", className)} {...props}>
        {children}
      </pre>
    </div>
  );
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <article className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkGitHubAlerts]}
        rehypePlugins={[
          rehypeRaw,
          rehypeSlug,
          [rehypeAutolinkHeadings, markdownAutolinkHeadingsOptions],
          [rehypeHighlight, markdownHighlightOptions],
          [rehypeSanitize, markdownSanitizeSchema],
        ]}
        components={{
          a: ({ href, children, ...props }) => {
            const normalizedHref = href ? normalizeInternalDocsLink(href.trim()) : "";
            const safeHref =
              normalizedHref && isSafeMarkdownHref(normalizedHref) ? normalizedHref : normalizedHref ? "#" : undefined;
            const external = safeHref?.startsWith("http://") || safeHref?.startsWith("https://");

            return (
              <a
                href={safeHref}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer noopener" : undefined}
                {...props}
              >
                {children}
              </a>
            );
          },
          img: ({ alt, ...props }) => (
            <img alt={alt ?? ""} loading="lazy" decoding="async" {...props} />
          ),
          pre: ({ children, className, ...props }) => (
            <CodeBlock className={className} {...props}>
              {children}
            </CodeBlock>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
