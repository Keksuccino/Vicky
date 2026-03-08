export const DEFAULT_FOOTER_TEXT = "Copyright © {{year}} {{owner}}. All rights reserved. | Powered by {{vicky}}.";
export const FALLBACK_FOOTER_OWNER = "Repository Owner";
export const MIN_FOOTER_YEAR = 2026;
export const VICKY_REPO_URL = "https://github.com/Keksuccino/Vicky";

const LEGACY_DEFAULT_FOOTER_TEXT = "Copyright © {{year}} {{owner}}. All rights reserved.";
const FOOTER_TOKEN_PATTERN = /{{\s*([a-z]+)\s*}}/gi;

export type FooterTemplatePart = {
  type: "text";
  value: string;
} | {
  type: "vicky";
};

export const normalizeFooterTemplate = (value: string): string => {
  const trimmed = value.trim();

  if (!trimmed || trimmed === LEGACY_DEFAULT_FOOTER_TEXT) {
    return DEFAULT_FOOTER_TEXT;
  }

  return trimmed;
};

export const resolveFooterTemplateParts = (template: string, owner: string): FooterTemplatePart[] => {
  const resolvedTemplate = normalizeFooterTemplate(template);
  const year = String(Math.max(new Date().getFullYear(), MIN_FOOTER_YEAR));
  const resolvedOwner = owner.trim() || FALLBACK_FOOTER_OWNER;
  const parts: FooterTemplatePart[] = [];
  let lastIndex = 0;

  for (const match of resolvedTemplate.matchAll(FOOTER_TOKEN_PATTERN)) {
    const tokenText = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      parts.push({
        type: "text",
        value: resolvedTemplate.slice(lastIndex, index),
      });
    }

    switch (match[1]?.toLowerCase()) {
      case "year":
        parts.push({ type: "text", value: year });
        break;
      case "owner":
        parts.push({ type: "text", value: resolvedOwner });
        break;
      case "vicky":
        parts.push({ type: "vicky" });
        break;
      default:
        parts.push({ type: "text", value: tokenText });
        break;
    }

    lastIndex = index + tokenText.length;
  }

  if (lastIndex < resolvedTemplate.length) {
    parts.push({
      type: "text",
      value: resolvedTemplate.slice(lastIndex),
    });
  }

  return parts;
};
