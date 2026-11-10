import matter from "gray-matter";
import GithubSlugger from "github-slugger";

import { isGitObjectSha } from "@/lib/github-paths";
import type { MarkdownHeading, ParsedMarkdownDocument } from "@/lib/types";

const headingRegex = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const fenceRegex = /^(```|~~~)/;

/**
 * Front-matter keys this app reads and writes. Every other key belongs to the author: saves edit
 * the managed keys in place and keep the rest of the front matter exactly as it was written.
 */
const TITLE_KEY = "title";
const DESCRIPTION_KEY = "description";
const EXCLUDE_FROM_AI_PLAINTEXT_KEY = "excludeFromAiPlaintext";
/**
 * Git blob SHA of the source page version a translation was made from. A translation that
 * records it is current exactly when it equals the source page's current blob SHA.
 */
const SOURCE_BLOB_SHA_KEY = "sourceBlobSha";
const MANAGED_KEYS = [TITLE_KEY, DESCRIPTION_KEY, EXCLUDE_FROM_AI_PLAINTEXT_KEY, SOURCE_BLOB_SHA_KEY] as const;

type ManagedKey = (typeof MANAGED_KEYS)[number];
/** New values of managed keys: `null` removes the key, a missing entry leaves it as it is. */
type ManagedValues = Partial<Record<ManagedKey, string | true | null>>;

const MANAGED_KEY_LINE = new RegExp(`^(["']?)(${MANAGED_KEYS.join("|")})\\1[ \\t]*:(?:\\s|$)`);
const PLAIN_YAML_OPENING = /^﻿?---[ \t]*\r?\n/;

type FrontMatterFile = { content: string; data: Record<string, unknown>; matter: string };

// Passing options, even empty ones, keeps gray-matter from caching every parsed input in its
// module-level `matter.cache`, which would otherwise retain each page version forever.
const parseFrontMatter = (markdown: string): FrontMatterFile => matter(markdown, {}) as unknown as FrontMatterFile;

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

const readSourceBlobSha = (value: unknown): string | undefined => {
  const sha = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isGitObjectSha(sha) ? sha : undefined;
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
  const parsed = parseFrontMatter(markdown ?? "");

  const title = typeof parsed.data.title === "string" ? parsed.data.title.trim() : "";
  const description = typeof parsed.data.description === "string" ? parsed.data.description.trim() : "";
  const content = parsed.content.replace(/\r\n/g, "\n");
  const includeInPlaintextExport = !isEnabledBoolean(parsed.data[EXCLUDE_FROM_AI_PLAINTEXT_KEY]);
  const sourceBlobSha = readSourceBlobSha(parsed.data[SOURCE_BLOB_SHA_KEY]);

  return {
    title,
    description,
    content,
    headings: extractHeadings(content),
    includeInPlaintextExport,
    ...(sourceBlobSha ? { sourceBlobSha } : {}),
  };
};

/** YAML lines of the given entries as gray-matter writes them: it returns `---\n<yaml>\n---\n\n` for an empty body. */
const yamlLines = (key: ManagedKey, value: string | true): string[] => {
  const block = matter.stringify("", { [key]: value });
  return block.slice(block.indexOf("\n") + 1, block.lastIndexOf("\n---")).split("\n");
};

const isBlank = (line: string): boolean => line.trim() === "";

/**
 * Line range of a top-level entry starting at `start`: its key line, then every line that still
 * belongs to its value (indented lines, blank lines inside block scalars, and the compact `- item`
 * lines YAML allows at the key's own indentation). Trailing blank lines stay outside the range.
 */
const entryEnd = (lines: string[], start: number): number => {
  let end = start + 1;
  while (end < lines.length && (isBlank(lines[end]) || /^[ \t]/.test(lines[end]) || /^-(?:[ \t]|$)/.test(lines[end]))) {
    end += 1;
  }
  while (end - 1 > start && isBlank(lines[end - 1])) {
    end -= 1;
  }
  return end;
};

/** Applies new values of managed keys to front-matter lines, touching no other line. */
const editFrontMatterLines = (source: string[], values: ManagedValues): string[] => {
  const lines = [...source];
  for (const key of MANAGED_KEYS) {
    if (!(key in values)) {
      continue;
    }

    const value = values[key];
    const replacement = value === null || value === undefined ? [] : yamlLines(key, value);
    let replaced = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (MANAGED_KEY_LINE.exec(lines[index])?.[2] !== key) {
        continue;
      }
      const end = entryEnd(lines, index);
      lines.splice(index, end - index, ...(replaced ? [] : replacement));
      index += (replaced ? 0 : replacement.length) - 1;
      replaced = true;
    }

    if (!replaced && replacement.length > 0) {
      while (lines.length > 0 && isBlank(lines[lines.length - 1])) {
        lines.pop();
      }
      lines.push(...replacement);
    }
  }
  return lines;
};

const unmanagedData = (data: Record<string, unknown>): string =>
  JSON.stringify(Object.entries(data).filter(([key]) => !(MANAGED_KEYS as readonly string[]).includes(key)));

const expectedValue = (value: string | true | null | undefined, actual: unknown, key: ManagedKey): boolean => {
  if (value === null || value === undefined) {
    return actual === undefined;
  }
  if (key === SOURCE_BLOB_SHA_KEY) {
    return readSourceBlobSha(actual) === value;
  }
  return value === true ? actual === true : typeof actual === "string" && actual.trim() === value;
};

/** Whether `written` holds exactly the intended managed values, the original unmanaged keys, and the body. */
const isFaithfulEdit = (written: string, original: FrontMatterFile | null, values: ManagedValues, body: string): boolean => {
  try {
    const reparsed = parseFrontMatter(written);
    return (
      reparsed.content === body &&
      unmanagedData(reparsed.data) === unmanagedData(original?.data ?? {}) &&
      MANAGED_KEYS.every((key) => (key in values ? expectedValue(values[key], reparsed.data[key], key) : JSON.stringify(reparsed.data[key]) === JSON.stringify(original?.data[key])))
    );
  } catch {
    return false;
  }
};

/**
 * Writes a document from `base` (the file being replaced, the Markdown a caller sent, or nothing)
 * with new managed front-matter values and the given body. The YAML of `base` is edited line by
 * line, so unmanaged keys keep their exact text: re-serializing through YAML would, for example,
 * turn `date: 2024-01-01` into `2024-01-01T00:00:00.000Z` and drop comments. If the edited text
 * would not parse back to exactly the intended data (unusual YAML layouts), the front matter is
 * serialized from the parsed data instead, which keeps every key and value but not their layout.
 */
const writeDocument = (base: string | undefined, values: ManagedValues, options: { body?: string; eol: "lf" | "preserve"; terminateBody: boolean }): string => {
  const original = base === undefined ? null : parseFrontMatter(base);
  const rawBody = options.body ?? original?.content ?? "";
  const hasFrontMatter = base !== undefined && /^﻿?---/.test(base) && base.replace(/^﻿/, "")[3] !== "-";
  const editable = !hasFrontMatter || PLAIN_YAML_OPENING.test(base ?? "");
  const rawMatter = hasFrontMatter ? (original?.matter ?? "") : "";
  const eol = options.eol === "preserve" && rawMatter.includes("\r\n") ? "\r\n" : "\n";

  if (editable) {
    // gray-matter's raw block starts with the rest of the opening line and ends before `\n---`.
    const sourceLines = rawMatter ? rawMatter.replace(/^[ \t]*\r?\n/, "").replace(/\r$/, "").split(/\r?\n/) : [];
    const lines = editFrontMatterLines(sourceLines, values);
    const hasEntries = lines.some((line) => !isBlank(line));
    // A body starting with `---` would be read as front matter, so it keeps an (empty) block.
    const needsBlock = hasEntries || rawBody.startsWith("---");
    const body = needsBlock && options.terminateBody && rawBody && !rawBody.endsWith("\n") ? `${rawBody}\n` : rawBody;
    const bom = base?.startsWith("﻿") ? "﻿" : "";
    const written = needsBlock ? `${bom}---${eol}${hasEntries ? `${lines.join(eol)}${eol}` : ""}---${eol}${body}` : `${bom}${body}`;
    if (isFaithfulEdit(written, original, values, body)) {
      return written;
    }
  }

  const data: Record<string, unknown> = { ...(original?.data ?? {}) };
  for (const key of MANAGED_KEYS) {
    if (key in values) {
      const value = values[key];
      if (value === null || value === undefined) {
        delete data[key];
      } else {
        data[key] = value;
      }
    }
  }
  return Object.keys(data).length === 0 && !rawBody.startsWith("---") ? rawBody : matter.stringify(rawBody, data);
};

export type MarkdownDocumentFields = {
  title?: string;
  description?: string;
  content: string;
  includeInPlaintextExport?: boolean;
  /** Source version of a translation; when unset, the value of `base` (if any) is kept. */
  sourceBlobSha?: string;
};

/**
 * Serializes a document from its fields. `base` is the document being replaced (or the Markdown
 * a caller sent): its front-matter keys that this app does not manage, comments, and formatting
 * are kept as written, and so is its recorded source version unless `input` sets a new one.
 */
export const serializeMarkdownDocument = (input: MarkdownDocumentFields, base?: string): string => {
  const sourceBlobSha = input.sourceBlobSha === undefined ? undefined : readSourceBlobSha(input.sourceBlobSha);
  if (input.sourceBlobSha !== undefined && !sourceBlobSha) {
    throw new Error(`"${input.sourceBlobSha}" is not a Git blob SHA.`);
  }

  return writeDocument(
    base,
    {
      [TITLE_KEY]: input.title?.trim() || null,
      [DESCRIPTION_KEY]: input.description?.trim() || null,
      [EXCLUDE_FROM_AI_PLAINTEXT_KEY]: input.includeInPlaintextExport === false ? true : null,
      ...(sourceBlobSha ? { [SOURCE_BLOB_SHA_KEY]: sourceBlobSha } : {}),
    },
    { body: input.content.replace(/\r\n/g, "\n"), eol: "lf", terminateBody: true },
  );
};

/**
 * Records the source version a translation was made from. Only the front matter changes: the
 * body, line endings, and every other key keep their exact bytes, so the page renders the same.
 */
export const withSourceBlobSha = (markdown: string, sourceBlobSha: string): string => {
  const sha = readSourceBlobSha(sourceBlobSha);
  if (!sha) {
    throw new Error(`"${sourceBlobSha}" is not a Git blob SHA.`);
  }
  return writeDocument(markdown, { [SOURCE_BLOB_SHA_KEY]: sha }, { eol: "preserve", terminateBody: false });
};
