import { createHash } from "node:crypto";

import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Node } from "unist";
import { SKIP, visit } from "unist-util-visit";

import {
  DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import { renderedMarkdownCache } from "@/lib/cache";
import { toRuntimeConfigCacheKey } from "@/lib/github";
import {
  isSafeMarkdownHref,
  MARKDOWN_RENDER_VERSION,
  markdownAutolinkHeadingsOptions,
  markdownHighlightOptions,
  markdownSanitizeSchema,
  normalizeInternalDocsLink,
} from "@/lib/markdown-rendering-shared";
import {
  readPersistentRenderedMarkdown,
  writePersistentRenderedMarkdown,
  type PersistedRenderedMarkdown,
} from "@/lib/markdown-render-cache-store";
import { remarkGitHubAlerts } from "@/lib/remark-github-alerts";
import type { GitHubDocPage, GitHubRuntimeConfig, MarkdownHeading } from "@/lib/types";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type HastParent = {
  children: HastNode[];
};

export type RenderedMarkdownDocument = PersistedRenderedMarkdown & {
  cacheKey: string;
  contentHash: string;
  rendererVersion: string;
};

export type RenderedGitHubDocPage = GitHubDocPage & {
  renderedHtml: string;
};

type MarkdownRenderQueueState = {
  renders: Map<string, Promise<RenderedMarkdownDocument>>;
};

const MARKDOWN_RENDER_QUEUE_STATE_KEY = Symbol.for("vicky.markdownRender.queueState");

const getMarkdownRenderQueueState = (): MarkdownRenderQueueState => {
  const globalState = globalThis as typeof globalThis & Record<symbol, MarkdownRenderQueueState | undefined>;
  let state = globalState[MARKDOWN_RENDER_QUEUE_STATE_KEY];

  if (!state) {
    state = {
      renders: new Map(),
    };
    globalState[MARKDOWN_RENDER_QUEUE_STATE_KEY] = state;
  }

  return state;
};

const hashValue = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 32);

const normalizeMarkdownLanguageCode = (value: string | undefined): string =>
  normalizeAutoTranslateLanguageCode(value) || DEFAULT_AUTO_TRANSLATE_LANGUAGE_CODE;

export const markdownRenderCachePrefix = (config: GitHubRuntimeConfig): string =>
  `${toRuntimeConfigCacheKey(config)}|markdown-render|`;

export const markdownRenderCacheKey = ({
  config,
  content,
  languageCode,
  slug,
}: {
  config: GitHubRuntimeConfig;
  content: string;
  languageCode?: string;
  slug: string;
}): { cacheKey: string; contentHash: string } => {
  const contentHash = hashValue(content);
  const cacheKey = `${markdownRenderCachePrefix(config)}${[
    MARKDOWN_RENDER_VERSION,
    slug,
    normalizeMarkdownLanguageCode(languageCode).toLowerCase(),
    contentHash,
  ].join("|")}`;

  return {
    cacheKey,
    contentHash,
  };
};

const isElement = (node: unknown): node is HastNode & { tagName: string } =>
  typeof node === "object" &&
  node !== null &&
  (node as HastNode).type === "element" &&
  typeof (node as HastNode).tagName === "string";

const isText = (node: unknown): node is HastNode & { value: string } =>
  typeof node === "object" &&
  node !== null &&
  (node as HastNode).type === "text" &&
  typeof (node as HastNode).value === "string";

const isParent = (node: unknown): node is HastParent => {
  if (typeof node !== "object" || node === null) {
    return false;
  }

  const children = (node as HastParent).children;
  return Array.isArray(children);
};

const readStringProperty = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(readStringProperty).filter((entry): entry is string => entry !== null).join(" ");
  }

  return null;
};

const normalizeClassName = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeClassName(entry));
  }

  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }

  return [];
};

const withClasses = (value: unknown, classes: string[]): string[] => {
  const nextClasses = normalizeClassName(value);

  for (const className of classes) {
    if (!nextClasses.includes(className)) {
      nextClasses.push(className);
    }
  }

  return nextClasses;
};

const hasClass = (value: unknown, className: string): boolean => normalizeClassName(value).includes(className);

const getProperties = (node: HastNode): Record<string, unknown> => {
  if (!node.properties || typeof node.properties !== "object") {
    node.properties = {};
  }

  return node.properties;
};

const nodeText = (node: unknown): string => {
  if (isText(node)) {
    return node.value;
  }

  if (isParent(node)) {
    return node.children.map(nodeText).join("");
  }

  return "";
};

const rehypeCollectHeadings = (headings: MarkdownHeading[]) => {
  return (tree: unknown) => {
    headings.splice(0, headings.length);

    visit(tree as Node, (node: unknown) => {
      if (!isElement(node)) {
        return;
      }

      const match = /^h([1-6])$/i.exec(node.tagName);
      if (!match) {
        return;
      }

      const properties = node.properties ?? {};
      const slug = readStringProperty(properties.id)?.trim();
      const text = nodeText(node).trim();

      if (!slug || !text) {
        return;
      }

      headings.push({
        depth: Number(match[1]),
        text,
        slug,
      });
    });
  };
};

const rehypeNormalizeLinksAndMedia = () => {
  return (tree: unknown) => {
    visit(tree as Node, (node: unknown) => {
      if (!isElement(node)) {
        return;
      }

      const properties = getProperties(node);

      if (node.tagName === "a") {
        const href = readStringProperty(properties.href)?.trim() ?? "";
        const normalizedHref = href ? normalizeInternalDocsLink(href) : "";
        const safeHref =
          normalizedHref && isSafeMarkdownHref(normalizedHref) ? normalizedHref : normalizedHref ? "#" : "";

        if (safeHref) {
          properties.href = safeHref;
        } else {
          delete properties.href;
        }

        const external = safeHref.startsWith("http://") || safeHref.startsWith("https://");
        if (external) {
          properties.target = "_blank";
          properties.rel = "noreferrer noopener";
        } else {
          delete properties.target;
          delete properties.rel;
        }
      }

      if (node.tagName === "img") {
        properties.alt = readStringProperty(properties.alt) ?? "";
        properties.loading = "lazy";
        properties.decoding = "async";
      }
    });
  };
};

const createCodeCopyButton = (): HastNode => ({
  type: "element",
  tagName: "button",
  properties: {
    type: "button",
    className: ["markdown-code-copy-button"],
    ariaLabel: "Copy code",
  },
  children: [
    {
      type: "element",
      tagName: "span",
      properties: {
        className: ["material-symbols-outlined", "markdown-code-copy-icon"],
      },
      children: [{ type: "text", value: "content_copy" }],
    },
  ],
});

const rehypeWrapCodeBlocks = () => {
  return (tree: unknown) => {
    visit(tree as Node, (node: unknown, index: number | undefined, parent: unknown) => {
      if (!isElement(node) || node.tagName !== "pre" || index === undefined || !isParent(parent)) {
        return;
      }

      if (isElement(parent) && hasClass(parent.properties?.className, "markdown-code-block-shell")) {
        return SKIP;
      }

      const properties = getProperties(node);
      properties.className = withClasses(properties.className, ["markdown-code-block"]);

      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: {
          className: ["markdown-code-block-shell"],
        },
        children: [createCodeCopyButton(), node],
      };

      return SKIP;
    });
  };
};

export const renderMarkdownToHtml = async (content: string): Promise<PersistedRenderedMarkdown> => {
  const headings: MarkdownHeading[] = [];
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkBreaks)
    .use(remarkGitHubAlerts)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(() => rehypeCollectHeadings(headings))
    .use(rehypeAutolinkHeadings, markdownAutolinkHeadingsOptions)
    .use(rehypeHighlight, markdownHighlightOptions)
    .use(rehypeNormalizeLinksAndMedia)
    .use(rehypeSanitize, markdownSanitizeSchema)
    .use(rehypeWrapCodeBlocks)
    .use(rehypeStringify)
    .process(content);

  return {
    html: String(file),
    headings,
  };
};

export const renderMarkdownToHtmlCached = async ({
  config,
  content,
  languageCode,
  slug,
}: {
  config: GitHubRuntimeConfig;
  content: string;
  languageCode?: string;
  slug: string;
}): Promise<RenderedMarkdownDocument> => {
  const normalizedContent = content ?? "";
  const { cacheKey, contentHash } = markdownRenderCacheKey({
    config,
    content: normalizedContent,
    languageCode,
    slug,
  });

  const fromMemory = renderedMarkdownCache.get(cacheKey) as PersistedRenderedMarkdown | undefined;
  if (fromMemory) {
    return {
      ...fromMemory,
      cacheKey,
      contentHash,
      rendererVersion: MARKDOWN_RENDER_VERSION,
    };
  }

  const queueState = getMarkdownRenderQueueState();
  const pending = queueState.renders.get(cacheKey);
  if (pending) {
    return pending;
  }

  const renderPromise = Promise.resolve()
    .then(async () => {
      const fromPersistentCache = await readPersistentRenderedMarkdown(cacheKey);
      if (fromPersistentCache) {
        renderedMarkdownCache.set(cacheKey, fromPersistentCache);
        return {
          ...fromPersistentCache,
          cacheKey,
          contentHash,
          rendererVersion: MARKDOWN_RENDER_VERSION,
        };
      }

      const rendered = await renderMarkdownToHtml(normalizedContent);
      renderedMarkdownCache.set(cacheKey, rendered);
      await writePersistentRenderedMarkdown(cacheKey, rendered);

      return {
        ...rendered,
        cacheKey,
        contentHash,
        rendererVersion: MARKDOWN_RENDER_VERSION,
      };
    })
    .finally(() => {
      if (queueState.renders.get(cacheKey) === renderPromise) {
        queueState.renders.delete(cacheKey);
      }
    });

  queueState.renders.set(cacheKey, renderPromise);
  return renderPromise;
};

export const renderGitHubDocPageMarkdown = async <TPage extends GitHubDocPage>({
  config,
  languageCode,
  page,
}: {
  config: GitHubRuntimeConfig;
  languageCode?: string;
  page: TPage;
}): Promise<TPage & RenderedGitHubDocPage> => {
  const rendered = await renderMarkdownToHtmlCached({
    config,
    content: page.content,
    languageCode,
    slug: page.slug,
  });

  return {
    ...page,
    headings: rendered.headings,
    renderedHtml: rendered.html,
  };
};
