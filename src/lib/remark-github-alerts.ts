import { visit } from "unist-util-visit";
import type { Node } from "unist";

const ALERT_TYPE_MAP: Record<string, string> = {
  NOTE: "info",
  INFO: "info",
  TIP: "success",
  SUCCESS: "success",
  IMPORTANT: "important",
  WARNING: "warning",
  CAUTION: "error",
  ERROR: "error",
};

const MARKER_REGEX = /^\s*\[!([A-Za-z]+)\]\s*(.*)$/;

type MarkdownTextNode = {
  type: "text";
  value: string;
};

type MarkdownParagraphNode = {
  type: "paragraph";
  children: MarkdownTextNode[];
  data?: {
    hProperties?: Record<string, unknown>;
  };
};

type MarkdownBlockquoteNode = {
  type: "blockquote";
  children: MarkdownParagraphNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
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

export function remarkGitHubAlerts() {
  return (tree: unknown) => {
    visit(tree as Node, (node) => {
      if (!isBlockquoteNode(node) || node.children.length === 0) {
        return;
      }

      const firstParagraph = node.children[0];
      if (!isParagraphNode(firstParagraph) || firstParagraph.children.length === 0) {
        return;
      }

      const firstTextNode = firstParagraph.children[0];
      if (!isTextNode(firstTextNode)) {
        return;
      }

      const match = MARKER_REGEX.exec(firstTextNode.value);
      if (!match) {
        return;
      }

      const rawType = match[1].toUpperCase();
      const variant = ALERT_TYPE_MAP[rawType] ?? "info";

      firstTextNode.value = firstTextNode.value.replace(MARKER_REGEX, "").trimStart();

      if (!firstTextNode.value) {
        firstParagraph.children.shift();
      }

      if (firstParagraph.children.length === 0) {
        node.children.shift();
      }

      node.data = {
        ...(node.data ?? {}),
        hName: "aside",
        hProperties: {
          ...((node.data && node.data.hProperties) || {}),
          className: ["md-alert", `md-alert-${variant}`],
          "data-alert": variant,
        },
      };
    });
  };
}
