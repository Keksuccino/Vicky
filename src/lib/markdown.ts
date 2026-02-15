import matter from "gray-matter";

import type { MarkdownHeading, ParsedMarkdownDocument } from "@/lib/types";

const headingRegex = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const fenceRegex = /^(```|~~~)/;

const sanitizeHeadingText = (text: string): string =>
  text
    .replace(/`+/g, "")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();

const baseSlug = (text: string): string =>
  sanitizeHeadingText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

export const extractHeadings = (markdown: string): MarkdownHeading[] => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const duplicates = new Map<string, number>();
  const headings: MarkdownHeading[] = [];

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

    const rawSlug = baseSlug(text);
    const count = duplicates.get(rawSlug) ?? 0;
    duplicates.set(rawSlug, count + 1);

    const slug = count === 0 ? rawSlug : `${rawSlug}-${count}`;
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

  return {
    title,
    description,
    content,
    headings: extractHeadings(content),
  };
};

export const serializeMarkdownDocument = (input: {
  title?: string;
  description?: string;
  content: string;
}): string => {
  const title = input.title?.trim() ?? "";
  const description = input.description?.trim() ?? "";
  const content = input.content.replace(/\r\n/g, "\n");
  const data: Record<string, string> = {};

  if (title) {
    data.title = title;
  }

  if (description) {
    data.description = description;
  }

  if (Object.keys(data).length === 0) {
    return content;
  }

  return matter.stringify(content, data).replace(/\r\n/g, "\n");
};
