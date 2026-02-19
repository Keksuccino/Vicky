import { visit } from "unist-util-visit";
import type { Node } from "unist";

const ALERT_TYPE_MAP: Record<string, string> = {
  NOTE: "info",
  INFO: "info",
  TIP: "tip",
  SUCCESS: "success",
  IMPORTANT: "important",
  WARNING: "warning",
  CAUTION: "error",
  ERROR: "error",
};

const MARKER_REGEX = /^\s*\[!([A-Za-z]+)\]\s*(.*)$/;
const WIKI_MARKER_REGEX = /^\s*\{\.is-(info|warning|success|danger)\}\s*$/i;
const WIKI_ALERT_TYPE_MAP: Record<string, string> = {
  INFO: "info",
  WARNING: "warning",
  SUCCESS: "success",
  DANGER: "error",
};

type MarkdownTextNode = {
  type: "text";
  value: string;
};

type MarkdownBreakNode = {
  type: "break";
};

type MarkdownInlineNode = MarkdownTextNode | MarkdownBreakNode | Record<string, unknown>;

type MarkdownParagraphNode = {
  type: "paragraph";
  children: MarkdownInlineNode[];
  data?: {
    hProperties?: Record<string, unknown>;
  };
};

type MarkdownBlockquoteNode = {
  type: "blockquote";
  children: unknown[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
};

type MarkdownParentNode = {
  children: unknown[];
};

function isBlockquoteNode(value: unknown): value is MarkdownBlockquoteNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.type === "blockquote" && Array.isArray(record.children);
}

function isParagraphNode(value: unknown): value is MarkdownParagraphNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.type === "paragraph" && Array.isArray(record.children);
}

function isTextNode(value: unknown): value is MarkdownTextNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.type === "text" && typeof record.value === "string";
}

function isBreakNode(value: unknown): value is MarkdownBreakNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return record.type === "break";
}

function isParentNode(value: unknown): value is MarkdownParentNode {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return Array.isArray(record.children);
}

function parseWikiMarker(value: string): string | null {
  const match = WIKI_MARKER_REGEX.exec(value);
  if (!match) {
    return null;
  }

  const rawType = match[1].toUpperCase();
  return WIKI_ALERT_TYPE_MAP[rawType] ?? null;
}

function trimLeadingParagraphWhitespace(paragraph: MarkdownParagraphNode) {
  while (paragraph.children.length > 0) {
    const leadingNode = paragraph.children[0];
    if (isBreakNode(leadingNode)) {
      paragraph.children.shift();
      continue;
    }

    if (isTextNode(leadingNode) && leadingNode.value.trim().length === 0) {
      paragraph.children.shift();
      continue;
    }

    break;
  }
}

function trimTrailingParagraphWhitespace(paragraph: MarkdownParagraphNode) {
  while (paragraph.children.length > 0) {
    const trailingNode = paragraph.children[paragraph.children.length - 1];
    if (isBreakNode(trailingNode)) {
      paragraph.children.pop();
      continue;
    }

    if (isTextNode(trailingNode) && trailingNode.value.trim().length === 0) {
      paragraph.children.pop();
      continue;
    }

    break;
  }
}

function extractGitHubVariant(blockquote: MarkdownBlockquoteNode): string | null {
  if (blockquote.children.length === 0) {
    return null;
  }

  const firstParagraph = blockquote.children[0];
  if (!isParagraphNode(firstParagraph) || firstParagraph.children.length === 0) {
    return null;
  }

  const firstTextNode = firstParagraph.children[0];
  if (!isTextNode(firstTextNode)) {
    return null;
  }

  const match = MARKER_REGEX.exec(firstTextNode.value);
  if (!match) {
    return null;
  }

  const rawType = match[1].toUpperCase();
  const variant = ALERT_TYPE_MAP[rawType] ?? "info";

  // Remove only the `[!TYPE]` marker and keep remaining user-authored text.
  firstTextNode.value = firstTextNode.value.replace(MARKER_REGEX, "$2").trimStart();
  trimLeadingParagraphWhitespace(firstParagraph);

  if (firstParagraph.children.length === 0) {
    blockquote.children.shift();
  }

  return variant;
}

function extractWikiVariantFromBlockquote(blockquote: MarkdownBlockquoteNode): string | null {
  if (blockquote.children.length === 0) {
    return null;
  }

  const lastChild = blockquote.children[blockquote.children.length - 1];
  if (!isParagraphNode(lastChild) || lastChild.children.length === 0) {
    return null;
  }

  const trailingInline = lastChild.children[lastChild.children.length - 1];
  if (!isTextNode(trailingInline)) {
    return null;
  }

  const variant = parseWikiMarker(trailingInline.value);
  if (!variant) {
    return null;
  }

  lastChild.children.pop();
  trimTrailingParagraphWhitespace(lastChild);

  if (lastChild.children.length === 0) {
    blockquote.children.pop();
  }

  return variant;
}

function extractWikiVariantFromSibling(parent: unknown, index: number | undefined): string | null {
  if (!isParentNode(parent) || index === undefined) {
    return null;
  }

  const sibling = parent.children[index + 1];
  if (!isParagraphNode(sibling) || sibling.children.length !== 1) {
    return null;
  }

  const onlyChild = sibling.children[0];
  if (!isTextNode(onlyChild)) {
    return null;
  }

  const variant = parseWikiMarker(onlyChild.value);
  if (!variant) {
    return null;
  }

  parent.children.splice(index + 1, 1);
  return variant;
}

function applyAlertVariant(blockquote: MarkdownBlockquoteNode, variant: string) {
  blockquote.data = {
    ...(blockquote.data ?? {}),
    hName: "aside",
    hProperties: {
      ...((blockquote.data && blockquote.data.hProperties) || {}),
      className: ["md-alert", `md-alert-${variant}`],
      "data-alert": variant,
    },
  };
}

export function remarkGitHubAlerts() {
  return (tree: unknown) => {
    visit(tree as Node, (node: unknown, index: number | undefined, parent: unknown) => {
      if (!isBlockquoteNode(node)) {
        return;
      }

      const githubVariant = extractGitHubVariant(node);
      const wikiVariant = extractWikiVariantFromBlockquote(node) ?? extractWikiVariantFromSibling(parent, index);
      const variant = githubVariant ?? wikiVariant;

      if (!variant) {
        return;
      }

      applyAlertVariant(node, variant);
    });
  };
}
