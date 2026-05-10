import { defaultSchema } from "rehype-sanitize";
import type { Options as RehypeAutolinkHeadingsOptions } from "rehype-autolink-headings";

export const MARKDOWN_RENDER_VERSION = "1";

const ALLOWED_SCHEME_HREF_REGEX = /^(https?:|mailto:|#)/i;
const ROOT_RELATIVE_HREF_REGEX = /^\/(?!\/)/;
const DOCS_HREF_REGEX = /^\/docs(?:[/?#]|$)/i;
const RESERVED_ROOT_HREF_REGEX = /^\/(?:api|admin|editor|_next)(?:[/?#]|$)/i;
const RESERVED_ROOT_FILE_HREF_REGEX = /^\/(?:favicon\.ico|robots\.txt|sitemap\.xml|manifest\.json)(?:[?#]|$)/i;

export const normalizeInternalDocsLink = (href: string): string => {
  if (!ROOT_RELATIVE_HREF_REGEX.test(href)) {
    return href;
  }

  if (DOCS_HREF_REGEX.test(href) || RESERVED_ROOT_HREF_REGEX.test(href) || RESERVED_ROOT_FILE_HREF_REGEX.test(href)) {
    return href;
  }

  const queryOrHashIndex = href.search(/[?#]/);
  const pathOnly = queryOrHashIndex >= 0 ? href.slice(0, queryOrHashIndex) : href;
  const suffix = queryOrHashIndex >= 0 ? href.slice(queryOrHashIndex) : "";
  const normalizedPath = pathOnly.replace(/\/{2,}/g, "/");
  const docsPath = normalizedPath === "/" ? "/docs" : `/docs${normalizedPath}`;

  return `${docsPath}${suffix}`;
};

export const isSafeMarkdownHref = (href: string): boolean =>
  ALLOWED_SCHEME_HREF_REGEX.test(href) || ROOT_RELATIVE_HREF_REGEX.test(href);

export const markdownAutolinkHeadingsOptions: RehypeAutolinkHeadingsOptions = {
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
};

export const markdownHighlightOptions = {
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
};

export const markdownSanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  tagNames: [...(defaultSchema.tagNames || []), "aside"],
  attributes: {
    ...(defaultSchema.attributes || {}),
    "*": [
      ...((defaultSchema.attributes && defaultSchema.attributes["*"]) || []),
      "className",
      "id",
      "dataAlert",
      "data-alert",
    ],
    a: [...((defaultSchema.attributes && defaultSchema.attributes.a) || []), "target", "rel"],
    code: [...((defaultSchema.attributes && defaultSchema.attributes.code) || []), "className"],
    img: [...((defaultSchema.attributes && defaultSchema.attributes.img) || []), "alt", "decoding", "loading"],
    pre: [...((defaultSchema.attributes && defaultSchema.attributes.pre) || []), "className"],
    span: [...((defaultSchema.attributes && defaultSchema.attributes.span) || []), "className"],
    aside: ["className", "dataAlert", "data-alert"],
    input: [...((defaultSchema.attributes && defaultSchema.attributes.input) || []), "checked", "disabled", "type"],
  },
};
