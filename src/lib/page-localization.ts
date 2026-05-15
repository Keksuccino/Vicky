import { ApiError } from "@/lib/http";
import { parseMarkdownDocument, serializeMarkdownDocument } from "@/lib/markdown";
import { requestOpenRouterChatCompletion } from "@/lib/openrouter";
import {
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguageCode,
} from "@/lib/auto-translate";
import { getDetailedAutoTranslateErrorMessage } from "@/lib/auto-translate-logging";
import {
  loadGitHubLocalizationSnapshot,
  loadGitHubLocalizedDoc,
  saveGitHubLocalizedDoc,
  type GitHubLocalizedDocResult,
} from "@/lib/github";
import type {
  AutoTranslateLanguage,
  AutoTranslateSettings,
  GitHubDocPage,
  GitHubRuntimeConfig,
  GitHubDocTreeItem,
} from "@/lib/types";

const TRANSLATION_CONCURRENCY = 50;
const TRANSLATION_MAX_RETRIES = 10;

export type PageLocalizationLanguageStatus = {
  languageCode: string;
  languageName: string;
  sourceLanguage: boolean;
  currentPages: number;
  missingPages: number;
  outdatedPages: number;
  totalPages: number;
};

export type PageLocalizationRequestMode = "outdated" | "missing-and-outdated";

export type PageLocalizationRequestResult = {
  totalPages: number;
  cachedPages: number;
  requestedPages: number;
  translatedPages: number;
  failedPages: number;
  failures: Array<{
    slug: string;
    path: string;
    languageCode: string;
    error: string;
  }>;
};

type TranslationPayload = {
  page_display_name: string;
  page_description: string;
  page_content: string;
};

type TranslationCandidate = {
  language: AutoTranslateLanguage;
  sourcePage: GitHubDocPage;
};

export type PageLocalizationTranslationEvent =
  | {
      type: "prepared";
      totalPages: number;
      currentPages: number;
      requestedPages: number;
      targetLanguages: number;
    }
  | {
      type: "page-start";
      attempt: number;
      maxAttempts: number;
      language: AutoTranslateLanguage;
      sourcePage: GitHubDocPage;
    }
  | {
      type: "page-retry";
      attempt: number;
      maxAttempts: number;
      error: string;
      language: AutoTranslateLanguage;
      sourcePage: GitHubDocPage;
    }
  | {
      type: "page-success";
      attempt: number;
      language: AutoTranslateLanguage;
      sourcePage: GitHubDocPage;
    }
  | {
      type: "page-failed";
      attempts: number;
      error: string;
      language: AutoTranslateLanguage;
      sourcePage: GitHubDocPage;
    };

const SYSTEM_PROMPT = `You are a professional Markdown documentation page translator.
Translate documentation pages into natural, clear language for the target audience.
Preserve Markdown formatting, links, image syntax, code fences, frontmatter meaning, and custom alert markers.
You receive pages as a JSON array with page title, page description, and page content.
Translate all three values, then return the translated content as the same JSON array syntax.
Only return the JSON array.`;

const mapWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  iteratee: (value: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (values.length === 0) {
    return [];
  }

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

const stripJsonCodeFence = (value: string): string => {
  const trimmed = value.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch?.[1]?.trim() ?? trimmed;
};

const parseJsonResponse = (value: string): unknown => {
  const normalized = stripJsonCodeFence(value);

  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    const firstArrayIndex = normalized.indexOf("[");
    const lastArrayIndex = normalized.lastIndexOf("]");
    if (firstArrayIndex >= 0 && lastArrayIndex > firstArrayIndex) {
      try {
        return JSON.parse(normalized.slice(firstArrayIndex, lastArrayIndex + 1)) as unknown;
      } catch {
        throw new ApiError(502, "OpenRouter returned translation JSON that could not be parsed.");
      }
    }

    throw new ApiError(502, "OpenRouter returned translation JSON that could not be parsed.");
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const normalizeTranslationResponse = (value: string): TranslationPayload => {
  const parsed = parseJsonResponse(value);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const record = asRecord(first);
  const title = record.page_display_name;
  const description = record.page_description;
  const content = record.page_content;

  if (typeof title !== "string" || typeof description !== "string" || typeof content !== "string") {
    throw new ApiError(502, "OpenRouter returned an invalid page translation payload.");
  }

  return {
    page_display_name: title.trim(),
    page_description: description.trim(),
    page_content: content,
  };
};

const buildTranslationPrompt = (targetLanguageDisplayName: string, page: GitHubDocPage): string => {
  const payload: TranslationPayload[] = [
    {
      page_display_name: page.title,
      page_description: page.description,
      page_content: page.content,
    },
  ];

  return `Translate the following page to ${targetLanguageDisplayName}. Return only the translated JSON array, nothing else:

${JSON.stringify(payload, null, 2)}`;
};

const toTranslatedMarkdown = (sourcePage: GitHubDocPage, translation: TranslationPayload): string => {
  const markdown = serializeMarkdownDocument({
    title: translation.page_display_name || sourcePage.title,
    description: translation.page_description,
    content: translation.page_content,
    includeInPlaintextExport: sourcePage.includeInPlaintextExport,
  });
  parseMarkdownDocument(markdown);
  return markdown;
};

const sourceFallbackPage = (sourcePage: GitHubDocPage, languageCode: string, status: "missing" | "outdated"): GitHubDocPage => ({
  ...sourcePage,
  languageCode,
  sourceLanguage: true,
  sourcePath: sourcePage.path,
  sourceSlug: sourcePage.slug,
  sourceUpdatedAt: sourcePage.updatedAt,
  translationStale: status === "outdated",
  localizationStatus: status,
});

export const isSourceLanguage = (language: Pick<AutoTranslateLanguage, "code">): boolean =>
  isDefaultAutoTranslateLanguageCode(language.code);

export const getCurrentLocalizedTreeItems = async ({
  config,
  language,
  localizationPath,
  sourcePages,
}: {
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  localizationPath: string;
  sourcePages: GitHubDocPage[];
}): Promise<Map<string, GitHubDocTreeItem>> => {
  if (isSourceLanguage(language)) {
    return new Map();
  }

  const snapshot = await loadGitHubLocalizationSnapshot({
    config,
    language,
    localizationPath,
    sourcePages,
  });
  const sourcePageByPath = new Map(sourcePages.map((page) => [page.path, page]));
  const output = new Map<string, GitHubDocTreeItem>();

  for (const page of snapshot.pages) {
    const sourcePage = sourcePageByPath.get(page.path);
    if (!sourcePage || isLocalizedPageOutdated(sourcePage, page)) {
      continue;
    }

    output.set(page.slug, {
      path: page.path,
      slug: page.slug,
      name: page.title.trim() || page.slug,
    });
  }

  return output;
};

export const isLocalizedPageOutdated = (sourcePage: GitHubDocPage, localizedPage: GitHubDocPage): boolean => {
  const sourceTime = sourcePage.updatedAt ? Date.parse(sourcePage.updatedAt) : Number.NaN;
  const translationTime = localizedPage.updatedAt ? Date.parse(localizedPage.updatedAt) : Number.NaN;

  return Number.isFinite(sourceTime) && Number.isFinite(translationTime) && sourceTime > translationTime;
};

export const getLocalizedPageForSource = async ({
  apiKey,
  config,
  language,
  localizationPath,
  model,
  origin,
  settings,
  siteTitle,
  sourcePage,
}: {
  apiKey?: string;
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  localizationPath: string;
  model?: string;
  origin: string;
  settings: AutoTranslateSettings;
  siteTitle: string;
  sourcePage: GitHubDocPage;
}): Promise<GitHubLocalizedDocResult> => {
  if (isSourceLanguage(language)) {
    return {
      sourcePage,
      page: {
        ...sourcePage,
        languageCode: language.code,
        sourceLanguage: true,
        localizationStatus: "source",
      },
      status: "current",
      localizedRepoPath: sourcePage.path,
    };
  }

  const localized = await loadGitHubLocalizedDoc({
    config,
    language,
    localizationPath,
    sourcePage,
  });

  if (localized.status !== "outdated" || !settings.enabled || !apiKey?.trim() || !model?.trim()) {
    return localized;
  }

  const updatedPage = await translatePageToGitHubLocalization({
    apiKey,
    config,
    language,
    localizationPath,
    model,
    origin,
    siteTitle,
    sourcePage: localized.sourcePage,
  });

  return {
    ...localized,
    page: updatedPage,
    status: "current",
  };
};

export const resolveServedLocalizedPage = (
  localized: GitHubLocalizedDocResult,
  language: AutoTranslateLanguage,
): GitHubDocPage => {
  if (localized.page && localized.status === "current") {
    return {
      ...localized.page,
      languageCode: language.code,
      sourceLanguage: false,
      localizationStatus: "current",
    };
  }

  return sourceFallbackPage(localized.sourcePage, language.code, localized.status === "outdated" ? "outdated" : "missing");
};

export const translatePageToGitHubLocalization = async ({
  apiKey,
  config,
  language,
  localizationPath,
  model,
  origin,
  siteTitle,
  sourcePage,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  language: AutoTranslateLanguage;
  localizationPath: string;
  model: string;
  origin: string;
  siteTitle: string;
  sourcePage: GitHubDocPage;
}): Promise<GitHubDocPage> => {
  const text = await requestOpenRouterChatCompletion({
    apiKey,
    model,
    origin,
    siteTitle,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildTranslationPrompt(language.name, sourcePage),
      },
    ],
  });

  const markdown = toTranslatedMarkdown(sourcePage, normalizeTranslationResponse(text));
  const result = await saveGitHubLocalizedDoc({
    config,
    language,
    localizationPath,
    sourcePage,
    input: {
      markdown,
      includeInPlaintextExport: sourcePage.includeInPlaintextExport,
      commitMessage: `docs: update ${language.code} localization for ${sourcePage.path}`,
    },
  });

  return result.page;
};

export const getPageLocalizationStatuses = async ({
  config,
  languages,
  localizationPath,
  sourcePages,
}: {
  config: GitHubRuntimeConfig;
  languages: AutoTranslateLanguage[];
  localizationPath: string;
  sourcePages: GitHubDocPage[];
}): Promise<PageLocalizationLanguageStatus[]> => {
  const totalPages = sourcePages.length;

  return Promise.all(
    languages.map(async (language): Promise<PageLocalizationLanguageStatus> => {
      if (isSourceLanguage(language)) {
        return {
          languageCode: language.code,
          languageName: language.name,
          sourceLanguage: true,
          currentPages: totalPages,
          missingPages: 0,
          outdatedPages: 0,
          totalPages,
        };
      }

      const snapshot = await loadGitHubLocalizationSnapshot({
        config,
        language,
        localizationPath,
        sourcePages,
      });
      const localizedByPath = new Map(snapshot.pages.map((page) => [page.path, page]));
      let currentPages = 0;
      let missingPages = 0;
      let outdatedPages = 0;

      for (const sourcePage of sourcePages) {
        const localizedPage = localizedByPath.get(sourcePage.path);
        if (!localizedPage) {
          missingPages += 1;
        } else if (isLocalizedPageOutdated(sourcePage, localizedPage)) {
          outdatedPages += 1;
        } else {
          currentPages += 1;
        }
      }

      return {
        languageCode: language.code,
        languageName: language.name,
        sourceLanguage: false,
        currentPages,
        missingPages,
        outdatedPages,
        totalPages,
      };
    }),
  );
};

export const translatePageLocalizations = async ({
  apiKey,
  config,
  languages,
  localizationPath,
  mode,
  model,
  onEvent,
  origin,
  siteTitle,
  sourcePages,
}: {
  apiKey: string;
  config: GitHubRuntimeConfig;
  languages: AutoTranslateLanguage[];
  localizationPath: string;
  mode: PageLocalizationRequestMode;
  model: string;
  onEvent?: (event: PageLocalizationTranslationEvent) => void;
  origin: string;
  siteTitle: string;
  sourcePages: GitHubDocPage[];
}): Promise<PageLocalizationRequestResult> => {
  const candidates: TranslationCandidate[] = [];
  let currentPages = 0;

  for (const language of languages) {
    if (isSourceLanguage(language)) {
      continue;
    }

    const snapshot = await loadGitHubLocalizationSnapshot({
      config,
      language,
      localizationPath,
      sourcePages,
    });
    const localizedByPath = new Map(snapshot.pages.map((page) => [page.path, page]));

    for (const sourcePage of sourcePages) {
      const localizedPage = localizedByPath.get(sourcePage.path);

      if (!localizedPage) {
        if (mode === "missing-and-outdated") {
          candidates.push({ language, sourcePage });
        }
        continue;
      }

      if (isLocalizedPageOutdated(sourcePage, localizedPage)) {
        candidates.push({ language, sourcePage });
      } else {
        currentPages += 1;
      }
    }
  }

  onEvent?.({
    type: "prepared",
    totalPages: sourcePages.length * Math.max(0, languages.filter((language) => !isSourceLanguage(language)).length),
    currentPages,
    requestedPages: candidates.length,
    targetLanguages: languages.filter((language) => !isSourceLanguage(language)).length,
  });

  const translateCandidate = async (candidate: TranslationCandidate) => {
    const maxAttempts = TRANSLATION_MAX_RETRIES + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      onEvent?.({
        type: "page-start",
        attempt,
        maxAttempts,
        language: candidate.language,
        sourcePage: candidate.sourcePage,
      });

      try {
        await translatePageToGitHubLocalization({
          apiKey,
          config,
          language: candidate.language,
          localizationPath,
          model,
          origin,
          siteTitle,
          sourcePage: candidate.sourcePage,
        });
        onEvent?.({
          type: "page-success",
          attempt,
          language: candidate.language,
          sourcePage: candidate.sourcePage,
        });
        return { ok: true as const };
      } catch (error: unknown) {
        const message = getDetailedAutoTranslateErrorMessage(error);

        if (attempt <= TRANSLATION_MAX_RETRIES) {
          onEvent?.({
            type: "page-retry",
            attempt,
            maxAttempts,
            error: message,
            language: candidate.language,
            sourcePage: candidate.sourcePage,
          });
          continue;
        }

        onEvent?.({
          type: "page-failed",
          attempts: attempt,
          error: message,
          language: candidate.language,
          sourcePage: candidate.sourcePage,
        });
        return {
          ok: false as const,
          error: message,
        };
      }
    }

    return {
      ok: false as const,
      error: "Translation failed without a reported error.",
    };
  };

  const results = await mapWithConcurrency(candidates, TRANSLATION_CONCURRENCY, async (candidate) => {
    return translateCandidate(candidate);
  });

  const failures: PageLocalizationRequestResult["failures"] = [];
  let translatedPages = 0;

  results.forEach((result, index) => {
    if (!result.ok) {
      const candidate = candidates[index];
      failures.push({
        slug: candidate.sourcePage.slug,
        path: candidate.sourcePage.path,
        languageCode: candidate.language.code,
        error: result.error,
      });
      return;
    }

    translatedPages += 1;
  });

  return {
    totalPages: sourcePages.length * Math.max(0, languages.filter((language) => !isSourceLanguage(language)).length),
    cachedPages: currentPages,
    requestedPages: candidates.length,
    translatedPages,
    failedPages: failures.length,
    failures,
  };
};

export const normalizeRequestedLocalizationLanguageCodes = (
  values: unknown,
  languages: AutoTranslateLanguage[],
): AutoTranslateLanguage[] => {
  if (!Array.isArray(values) || values.length === 0) {
    return languages.filter((language) => !isSourceLanguage(language));
  }

  const requested = new Set(
    values
      .map((value) => (typeof value === "string" ? normalizeAutoTranslateLanguageCode(value).toLowerCase() : ""))
      .filter(Boolean),
  );

  return languages.filter(
    (language) => !isSourceLanguage(language) && requested.has(normalizeAutoTranslateLanguageCode(language.code).toLowerCase()),
  );
};
