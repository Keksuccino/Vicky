"use client";

import { isValidElement, useCallback, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "@/components/cn";
import { remarkGitHubAlerts } from "@/lib/remark-github-alerts";

type MarkdownRendererProps = {
  content: string;
};

const ALLOWED_HREF_REGEX = /^(https?:|mailto:|\/|#)/i;
const ROOT_SHORT_LINK_REGEX = /^\/(?!docs(?:[/?#]|$))[^/?#]+(?:[?#].*)?$/;
const COPIED_STATE_DURATION_MS = 1400;

type CodeBlockProps = ComponentPropsWithoutRef<"pre">;

const normalizeInternalDocsLink = (href: string): string => {
  if (!ROOT_SHORT_LINK_REGEX.test(href)) {
    return href;
  }

  return `/docs${href}`;
};

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

const fallbackCopyText = (text: string): boolean => {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
};

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const codeText = useMemo(() => getNodeText(children).replace(/\n$/, ""), [children]);

  const handleCopy = useCallback(async () => {
    if (!codeText) {
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(codeText);
      } else if (!fallbackCopyText(codeText)) {
        return;
      }
      setCopied(true);
    } catch {
      if (fallbackCopyText(codeText)) {
        setCopied(true);
      }
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

const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames || []), "aside"],
  attributes: {
    ...(defaultSchema.attributes || {}),
    "*": [...((defaultSchema.attributes && defaultSchema.attributes["*"]) || []), "className", "id", "data-alert"],
    a: [...((defaultSchema.attributes && defaultSchema.attributes.a) || []), "target", "rel"],
    code: [...((defaultSchema.attributes && defaultSchema.attributes.code) || []), "className"],
    pre: [...((defaultSchema.attributes && defaultSchema.attributes.pre) || []), "className"],
    span: [...((defaultSchema.attributes && defaultSchema.attributes.span) || []), "className"],
    aside: ["className", "data-alert"],
    input: [...((defaultSchema.attributes && defaultSchema.attributes.input) || []), "checked", "disabled", "type"],
  },
};

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <article className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkGitHubAlerts]}
        rehypePlugins={[
          rehypeRaw,
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: "append",
              properties: { className: ["heading-anchor"] },
              content: {
                type: "element",
                tagName: "span",
                properties: { className: ["heading-anchor-wrap"] },
                children: [
                  {
                    type: "element",
                    tagName: "span",
                    properties: { className: ["material-symbols-outlined", "anchor-icon"] },
                    children: [{ type: "text", value: "link" }],
                  },
                ],
              },
            },
          ],
          [
            rehypeHighlight,
            {
              detect: false,
              ignoreMissing: true,
              aliases: {
                html: "xml",
                js: "javascript",
                jsx: "javascript",
                mjs: "javascript",
                patch: "diff",
                plain: "plaintext",
                text: "plaintext",
                txt: "plaintext",
              },
              plainText: ["plain", "text", "txt", "plaintext"],
            },
          ],
          [rehypeSanitize, sanitizeSchema],
        ]}
        components={{
          a: ({ href, children, ...props }) => {
            const normalizedHref = href ? normalizeInternalDocsLink(href.trim()) : "";
            const safeHref =
              normalizedHref && ALLOWED_HREF_REGEX.test(normalizedHref) ? normalizedHref : normalizedHref ? "#" : undefined;
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
