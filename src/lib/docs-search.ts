import { docsSearchCorpusCache } from "@/lib/cache";
import { listMarkdownDocsTree, loadGitHubDoc, toRuntimeConfigCacheKey } from "@/lib/github";
import type { GitHubDocTreeItem, GitHubRuntimeConfig, MarkdownHeading } from "@/lib/types";

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 100;
const PAGE_LOAD_CONCURRENCY = 6;
const EXCERPT_LENGTH = 220;
const headingRegex = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const fenceRegex = /^(```|~~~)/;

type SearchField = "title" | "name" | "description" | "content";

type SearchableDoc = {
  slug: string;
  path: string;
  name: string;
  title: string;
  description: string;
  contentText: string;
  normalized: Record<SearchField, string>;
  words: Record<SearchField, string[]>;
  sections: SearchableDocSection[];
};

type SearchableDocSection = {
  anchor?: string;
  headingText: string;
  headingNormalized: string;
  headingWords: string[];
  plainText: string;
  normalized: string;
  words: string[];
};

export type DocsSearchResult = {
  slug: string;
  path: string;
  name: string;
  title: string;
  description?: string;
  excerpt?: string;
  anchor?: string;
  score: number;
};

const FIELD_WEIGHTS: Record<SearchField, number> = {
  title: 3.0,
  name: 2.4,
  description: 1.8,
  content: 1.1,
};

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const stripMarkdownForSearch = (value: string): string =>
  value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ");

const normalizeSearchText = (value: string): string =>
  collapseWhitespace(
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[`*_~>#()[\]{}|\\/:;,.!?"+=<>\-']/g, " "),
  );

const toWords = (value: string): string[] => {
  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return [];
  }

  return normalized.split(" ").filter(Boolean);
};

const toNormalizedWords = (normalized: string): string[] => {
  if (!normalized) {
    return [];
  }

  return normalized.split(" ").filter(Boolean);
};

const splitIntoSections = (content: string, headings: MarkdownHeading[]): SearchableDocSection[] => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: SearchableDocSection[] = [];
  let inFence = false;
  let headingIndex = 0;
  let currentHeading: MarkdownHeading | null = null;
  let currentLines: string[] = [];

  const flushSection = () => {
    const headingText = currentHeading?.text ?? "";
    const bodyText = collapseWhitespace(stripMarkdownForSearch(currentLines.join("\n")));
    const merged = collapseWhitespace([headingText, bodyText].filter(Boolean).join(" "));

    if (!merged) {
      currentLines = [];
      return;
    }

    sections.push({
      anchor: currentHeading?.slug,
      headingText,
      headingNormalized: normalizeSearchText(headingText),
      headingWords: toWords(headingText),
      plainText: merged,
      normalized: normalizeSearchText(merged),
      words: toWords(merged),
    });
    currentLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (fenceRegex.test(trimmed)) {
      inFence = !inFence;
      currentLines.push(line);
      continue;
    }

    if (!inFence && headingRegex.test(trimmed)) {
      flushSection();
      currentHeading = headings[headingIndex] ?? null;
      headingIndex += 1;
      continue;
    }

    currentLines.push(line);
  }

  flushSection();
  return sections;
};

const toSearchableDoc = async (
  config: GitHubRuntimeConfig,
  treeItem: GitHubDocTreeItem,
): Promise<SearchableDoc | null> => {
  try {
    const page = await loadGitHubDoc(config, { slug: treeItem.slug });
    const title = page.title.trim() || treeItem.name;
    const description = page.description.trim();
    const contentText = collapseWhitespace(stripMarkdownForSearch(page.content));
    const sections = splitIntoSections(page.content, page.headings);

    const normalized: Record<SearchField, string> = {
      name: normalizeSearchText(treeItem.name),
      title: normalizeSearchText(title),
      description: normalizeSearchText(description),
      content: normalizeSearchText(contentText),
    };

    return {
      slug: page.slug,
      path: page.path,
      name: treeItem.name,
      title,
      description,
      contentText,
      normalized,
      words: {
        name: toNormalizedWords(normalized.name),
        title: toNormalizedWords(normalized.title),
        description: toNormalizedWords(normalized.description),
        content: toNormalizedWords(normalized.content),
      },
      sections,
    };
  } catch {
    return null;
  }
};

const mapWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  iteratee: (value: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const workerCount = Math.max(1, Math.min(concurrency, values.length));
  const output = new Array<R>(values.length);
  let index = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (index < values.length) {
      const currentIndex = index;
      index += 1;
      output[currentIndex] = await iteratee(values[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return output;
};

const loadSearchCorpus = async (config: GitHubRuntimeConfig): Promise<SearchableDoc[]> => {
  const cacheKey = `${toRuntimeConfigCacheKey(config)}|search-corpus`;
  const cached = docsSearchCorpusCache.get(cacheKey);
  if (cached) {
    return cached as SearchableDoc[];
  }

  const tree = await listMarkdownDocsTree(config);
  if (tree.length === 0) {
    docsSearchCorpusCache.set(cacheKey, []);
    return [];
  }

  const pages = await mapWithConcurrency(tree, PAGE_LOAD_CONCURRENCY, async (item) => toSearchableDoc(config, item));
  const corpus = pages.filter((entry): entry is SearchableDoc => Boolean(entry));

  docsSearchCorpusCache.set(cacheKey, corpus);
  return corpus;
};

const tokenLengthFactor = (token: string): number => Math.max(0.35, Math.min(1, token.length / 4));

const tokenStrength = (word: string, token: string): number => {
  if (!word || !token) {
    return 0;
  }

  if (word === token) {
    return 1;
  }

  const ratio = token.length / Math.max(word.length, token.length);
  const factor = tokenLengthFactor(token);

  if (word.startsWith(token)) {
    return (0.6 + ratio * 0.3) * factor;
  }

  if (token.length >= 2 && word.includes(token)) {
    return (0.45 + ratio * 0.25) * factor;
  }

  return 0;
};

const scoreOrderedTokenMatch = (
  words: string[],
  queryTokens: string[],
): { score: number; firstWordIndex: number } => {
  if (words.length === 0 || queryTokens.length === 0) {
    return { score: 0, firstWordIndex: -1 };
  }

  let cursor = 0;
  let matchedTokens = 0;
  let strengthTotal = 0;
  let totalGap = 0;
  let lastWordIndex = -1;
  let firstWordIndex = -1;

  for (const token of queryTokens) {
    let matchedIndex = -1;
    let matchedStrength = 0;

    for (let i = cursor; i < words.length; i += 1) {
      const strength = tokenStrength(words[i], token);
      if (strength <= 0) {
        continue;
      }

      matchedIndex = i;
      matchedStrength = strength;
      break;
    }

    if (matchedIndex < 0) {
      break;
    }

    if (firstWordIndex < 0) {
      firstWordIndex = matchedIndex;
    }

    if (lastWordIndex >= 0) {
      totalGap += Math.max(0, matchedIndex - lastWordIndex - 1);
    }

    lastWordIndex = matchedIndex;
    cursor = matchedIndex + 1;
    matchedTokens += 1;
    strengthTotal += matchedStrength;
  }

  if (matchedTokens === 0) {
    return { score: 0, firstWordIndex: -1 };
  }

  const coverage = matchedTokens / queryTokens.length;
  const averageStrength = strengthTotal / matchedTokens;
  const gapPenalty = 1 / (1 + totalGap / Math.max(1, matchedTokens));
  const fullCoverageBonus = matchedTokens === queryTokens.length ? 0.18 : 0;

  const score = coverage * (0.62 + averageStrength * 0.38) * gapPenalty + fullCoverageBonus;

  return { score, firstWordIndex };
};

const scoreTokenCoverage = (words: string[], queryTokens: string[]): { score: number; firstWordIndex: number } => {
  if (words.length === 0 || queryTokens.length === 0) {
    return { score: 0, firstWordIndex: -1 };
  }

  let matchedTokens = 0;
  let strengthTotal = 0;
  let firstWordIndex = -1;

  for (const token of queryTokens) {
    let bestStrength = 0;
    let bestIndex = -1;

    for (let i = 0; i < words.length; i += 1) {
      const strength = tokenStrength(words[i], token);
      if (strength <= bestStrength) {
        continue;
      }

      bestStrength = strength;
      bestIndex = i;

      if (strength === 1) {
        break;
      }
    }

    if (bestStrength <= 0) {
      continue;
    }

    matchedTokens += 1;
    strengthTotal += bestStrength;

    if (firstWordIndex < 0 || bestIndex < firstWordIndex) {
      firstWordIndex = bestIndex;
    }
  }

  if (matchedTokens === 0) {
    return { score: 0, firstWordIndex: -1 };
  }

  const coverage = matchedTokens / queryTokens.length;
  const averageStrength = strengthTotal / matchedTokens;

  return {
    score: coverage * (0.5 + averageStrength * 0.5),
    firstWordIndex,
  };
};

const scoreField = (
  normalizedField: string,
  fieldWords: string[],
  normalizedQuery: string,
  queryTokens: string[],
): { score: number; exactPhrase: boolean } => {
  if (!normalizedField) {
    return { score: 0, exactPhrase: false };
  }

  let bestScore = 0;
  let exactPhrase = false;

  const phraseIndex = normalizedField.indexOf(normalizedQuery);
  if (phraseIndex >= 0) {
    exactPhrase = true;
    const earlyBoost = 1 - Math.min(0.35, phraseIndex / Math.max(1, normalizedField.length));
    bestScore = 1.45 + earlyBoost * 0.35;
  }

  const orderedMatch = scoreOrderedTokenMatch(fieldWords, queryTokens);
  if (orderedMatch.score > 0) {
    bestScore = Math.max(bestScore, orderedMatch.score * 1.05);
  }

  const coverageMatch = scoreTokenCoverage(fieldWords, queryTokens);
  if (coverageMatch.score > 0) {
    bestScore = Math.max(bestScore, coverageMatch.score * 0.8);
  }

  return {
    score: bestScore,
    exactPhrase,
  };
};

const findBestSection = (
  sections: SearchableDocSection[],
  normalizedQuery: string,
  queryTokens: string[],
): SearchableDocSection | null => {
  if (sections.length === 0) {
    return null;
  }

  let best: SearchableDocSection | null = null;
  let bestScore = 0;

  for (const section of sections) {
    if (!section.normalized || section.words.length === 0) {
      continue;
    }

    const combinedMatch = scoreField(section.normalized, section.words, normalizedQuery, queryTokens);
    const headingMatch = section.headingText
      ? scoreField(section.headingNormalized, section.headingWords, normalizedQuery, queryTokens)
      : { score: 0, exactPhrase: false };

    const score = combinedMatch.score + headingMatch.score * 0.25 + (combinedMatch.exactPhrase ? 0.15 : 0);

    if (score <= bestScore) {
      continue;
    }

    bestScore = score;
    best = section;
  }

  return best;
};

const truncate = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
};

const buildExcerpt = (source: string, query: string, queryTokens: string[]): string | undefined => {
  const plain = collapseWhitespace(source);
  if (!plain) {
    return undefined;
  }

  if (plain.length <= EXCERPT_LENGTH) {
    return plain;
  }

  const lowercaseSource = plain.toLowerCase();
  const lowercaseQuery = query.toLowerCase();
  let index = lowercaseSource.indexOf(lowercaseQuery);

  if (index < 0) {
    for (const token of queryTokens) {
      index = lowercaseSource.indexOf(token.toLowerCase());
      if (index >= 0) {
        break;
      }
    }
  }

  if (index < 0) {
    return truncate(plain, EXCERPT_LENGTH);
  }

  let start = Math.max(0, index - Math.floor(EXCERPT_LENGTH * 0.28));
  const end = Math.min(plain.length, start + EXCERPT_LENGTH);

  if (end - start < EXCERPT_LENGTH && start > 0) {
    start = Math.max(0, end - EXCERPT_LENGTH);
  }

  let excerpt = plain.slice(start, end).trim();
  if (start > 0) {
    excerpt = `…${excerpt}`;
  }
  if (end < plain.length) {
    excerpt = `${excerpt}…`;
  }

  return excerpt;
};

const toScore = (value: number): number => Math.round(value * 1000) / 1000;

const normalizeLimit = (limit: number | undefined): number => {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }

  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.round(limit)));
};

export const searchDocsCorpus = async (
  config: GitHubRuntimeConfig,
  query: string,
  options?: { limit?: number },
): Promise<DocsSearchResult[]> => {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const queryTokens = toWords(normalizedQuery);
  if (queryTokens.length === 0) {
    return [];
  }

  const corpus = await loadSearchCorpus(config);
  const results: DocsSearchResult[] = [];

  for (const doc of corpus) {
    const fieldScores: Record<SearchField, { score: number; exactPhrase: boolean }> = {
      title: scoreField(doc.normalized.title, doc.words.title, normalizedQuery, queryTokens),
      name: scoreField(doc.normalized.name, doc.words.name, normalizedQuery, queryTokens),
      description: scoreField(doc.normalized.description, doc.words.description, normalizedQuery, queryTokens),
      content: scoreField(doc.normalized.content, doc.words.content, normalizedQuery, queryTokens),
    };

    const matchedContent = fieldScores.content.score > 0;
    const bestSection = matchedContent ? findBestSection(doc.sections, normalizedQuery, queryTokens) : null;
    const contentAnchor = bestSection?.anchor;
    const contentExcerptSource = bestSection?.plainText || doc.contentText;

    let score = 0;
    let matchedFields = 0;
    let exactPhraseMatches = 0;
    let bestField: SearchField = "content";
    let bestFieldWeightedScore = 0;

    for (const field of Object.keys(fieldScores) as SearchField[]) {
      const fieldScore = fieldScores[field];
      if (fieldScore.score <= 0) {
        continue;
      }

      const weighted = fieldScore.score * FIELD_WEIGHTS[field];
      score += weighted;
      matchedFields += 1;

      if (fieldScore.exactPhrase) {
        exactPhraseMatches += 1;
      }

      if (weighted > bestFieldWeightedScore) {
        bestFieldWeightedScore = weighted;
        bestField = field;
      }
    }

    if (score <= 0) {
      continue;
    }

    if (matchedFields > 1) {
      score += 0.2 * matchedFields;
    }
    if (exactPhraseMatches > 0) {
      score += 0.3 * exactPhraseMatches;
    }

    const excerptSource =
      bestField === "description"
        ? doc.description
        : bestField === "content"
          ? contentExcerptSource
          : doc.description || doc.contentText;

    results.push({
      slug: doc.slug,
      path: doc.path,
      name: doc.name,
      title: doc.title,
      description: doc.description || undefined,
      excerpt: buildExcerpt(excerptSource, query, queryTokens),
      ...(contentAnchor ? { anchor: contentAnchor } : {}),
      score: toScore(score),
    });
  }

  const limit = normalizeLimit(options?.limit);

  return results.sort((left, right) => right.score - left.score).slice(0, limit);
};
