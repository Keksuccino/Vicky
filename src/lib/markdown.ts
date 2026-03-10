import matter from "gray-matter";
import GithubSlugger from "github-slugger";

import type { MarkdownHeading, ParsedMarkdownDocument } from "@/lib/types";

const headingRegex = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const fenceRegex = /^(```|~~~)/;
const EXCLUDE_FROM_AI_PLAINTEXT_KEY = "excludeFromAiPlaintext";

const sanitizeHeadingText = (text: string): string =>
  text
    .replace(/`+/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();

const isEnabledBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }

  return false;
};

export const extractHeadings = (markdown: string): MarkdownHeading[] => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headings: MarkdownHeading[] = [];
  const slugger = new GithubSlugger();

  let inFence = false;

  for (const line of lines) {
    if (fenceRegex.test(line.trim())) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      continue;
    }

    const match = headingRegex.exec(line);
    if (!match) {
      continue;
    }

    const [, level, rawText] = match;
    const text = sanitizeHeadingText(rawText);
    if (!text) {
      continue;
    }

    const slug = slugger.slug(text);
    headings.push({
      depth: level.length,
      text,
      slug,
    });
  }

  return headings;
};

export const parseMarkdownDocument = (markdown: string): ParsedMarkdownDocument => {
  const parsed = matter(markdown ?? "");

  const title = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
  const description = typeof parsed.data.description === "string" ? parsed.data.description.trim() : "";
  const content = parsed.content.replace(/\r\n/g, "\n");
  const includeInPlaintextExport = !isEnabledBoolean(parsed.data[EXCLUDE_FROM_AI_PLAINTEXT_KEY]);

  return {
    title,
    description,
    content,
    headings: extractHeadings(content),
    includeInPlaintextExport,
  };
};

export const serializeMarkdownDocument = (input: {
  title?: string;
  description?: string;
  content: string;
  includeInPlaintextExport?: boolean;
}): string => {
  const title = input.title?.trim() ?? "";
  const description = input.description?.trim() ?? "";
  const content = input.content.replace(/\r\n/g, "\n");
  const data: Record<string, string | boolean> = {};

  if (title) {
    data.title = title;
  }

  if (description) {
    data.description = description;
  }

  if (input.includeInPlaintextExport === false) {
    data[EXCLUDE_FROM_AI_PLAINTEXT_KEY] = true;
  }

  if (Object.keys(data).length === 0) {
    return content;
  }

  return matter.stringify(content, data).replace(/\r\n/g, "\n");
};
