import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import {
  AI_CHAT_DOCS_PLACEHOLDER,
  normalizeAiAssistantName,
  normalizeAiChatAvatarUrl,
  normalizeAiChatHeaderSubtitle,
  normalizeAiChatSystemPromptTemplate,
  normalizeAiChatWelcomeMessage,
} from "@/lib/ai-chat";
import {
  isDefaultAutoTranslateLanguageCode,
  normalizeAutoTranslateLanguages,
  normalizeAutoTranslateOpenRouterModel,
  normalizeAutoTranslateRequestTimeoutMs,
  normalizeLocalizationPath,
} from "@/lib/auto-translate";
import {
  formatAutoTranslateLanguageForLog,
  logAutoTranslateInfo,
} from "@/lib/auto-translate-logging";
import { requireAdminRequest } from "@/lib/auth";
import { MAX_DOCS_CACHE_TTL_MS, MIN_DOCS_CACHE_TTL_MS, setDocsCacheTtlMs } from "@/lib/cache";
import { isCircleFlagIconId } from "@/lib/circle-flags";
import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import { decryptSecret, encryptSecret } from "@/lib/encryption";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { normalizeStartPage } from "@/lib/start-page";
import { getPublicSettings, getStore, updateStore } from "@/lib/store";
import type { AutoTranslateLanguage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settingsPatchSchema = z
  .object({
    siteTitle: z.string().min(1).optional(),
    siteDescription: z.string().min(1).optional(),
    footerText: z.string().optional(),
    startPage: z.string().optional(),
    siteTitleGradient: z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .optional(),
    docsIcon: z
      .object({
        png16Url: z.string().optional(),
        png32Url: z.string().optional(),
        png180Url: z.string().optional(),
      })
      .optional(),
    docsCacheTtlMs: z.coerce.number().int().min(MIN_DOCS_CACHE_TTL_MS).max(MAX_DOCS_CACHE_TTL_MS).optional(),
    domain: z
      .object({
        customDomain: z.string().optional(),
        letsEncryptEmail: z.string().optional(),
      })
      .optional(),
    theme: z
      .object({
        lightAccent: z.string().optional(),
        lightSurfaceAccent: z.string().optional(),
        darkAccent: z.string().optional(),
        darkSurfaceAccent: z.string().optional(),
        customCss: z.string().optional(),
      })
      .optional(),
    github: z
      .object({
        owner: z.string().optional(),
        repo: z.string().optional(),
        branch: z.string().optional(),
        docsPath: z.string().optional(),
        token: z.string().optional(),
      })
      .optional(),
    aiChat: z
      .object({
        enabled: z.boolean().optional(),
        assistantName: z.string().optional(),
        avatarUrl: z.string().optional(),
        headerSubtitle: z.string().optional(),
        welcomeMessage: z.string().optional(),
        openRouterModel: z.string().optional(),
        openRouterApiKey: z.string().optional(),
        systemPrompt: z.string().optional(),
      })
      .optional(),
    openRouter: z
      .object({
        apiKey: z.string().optional(),
      })
      .optional(),
    autoTranslate: z
      .object({
        enabled: z.boolean().optional(),
        openRouterModel: z.string().optional(),
        requestTimeoutMs: z.union([z.number(), z.string()]).optional(),
        localizationPath: z.string().optional(),
        directory: z.string().optional(),
        languages: z
          .array(
            z
              .object({
                name: z.string(),
                code: z.string(),
                enabled: z.boolean().optional(),
                icon: z
                  .string()
                  .refine(isCircleFlagIconId, "Language icon must be a Circle Flags icon ID."),
              })
              .strict(),
          )
          .optional(),
      })
      .optional(),
  })
  .strict();

const autoTranslateLanguageKey = (language: AutoTranslateLanguage): string => language.code.toLowerCase();

const autoTranslateLanguageMap = (languages: AutoTranslateLanguage[]): Map<string, AutoTranslateLanguage> =>
  new Map(languages.map((language) => [autoTranslateLanguageKey(language), language]));

const decryptStoredSecret = (encrypted: string | null): string => {
  if (!encrypted) {
    return "";
  }

  try {
    return decryptSecret(encrypted).trim();
  } catch {
    return "";
  }
};

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const store = await getStore();

    return NextResponse.json({
      settings: getPublicSettings(store.settings),
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};

export const PATCH = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await parseJsonBody<unknown>(request);
    const patch = settingsPatchSchema.parse(body);
    const autoTranslateSettingLogs: Array<() => void> = [];

    const updatedStore = await updateStore(async (store) => {
      if (patch.siteTitle !== undefined) {
        store.settings.siteTitle = patch.siteTitle.trim() || store.settings.siteTitle;
      }

      if (patch.siteDescription !== undefined) {
        store.settings.siteDescription = patch.siteDescription.trim() || store.settings.siteDescription;
      }

      if (patch.footerText !== undefined) {
        store.settings.footerText = patch.footerText.trim() || store.settings.footerText;
      }

      if (patch.startPage !== undefined) {
        store.settings.startPage = normalizeStartPage(patch.startPage);
      }

      if (patch.siteTitleGradient) {
        if (patch.siteTitleGradient.from !== undefined) {
          store.settings.siteTitleGradient.from = patch.siteTitleGradient.from.trim();
        }

        if (patch.siteTitleGradient.to !== undefined) {
          store.settings.siteTitleGradient.to = patch.siteTitleGradient.to.trim();
        }
      }

      if (patch.docsIcon) {
        if (patch.docsIcon.png16Url !== undefined) {
          store.settings.docsIcon.png16Url = patch.docsIcon.png16Url.trim();
        }

        if (patch.docsIcon.png32Url !== undefined) {
          store.settings.docsIcon.png32Url = patch.docsIcon.png32Url.trim();
        }

        if (patch.docsIcon.png180Url !== undefined) {
          store.settings.docsIcon.png180Url = patch.docsIcon.png180Url.trim();
        }
      }

      if (patch.docsCacheTtlMs !== undefined) {
        store.settings.docsCacheTtlMs = patch.docsCacheTtlMs;
      }

      if (patch.domain) {
        if (patch.domain.customDomain !== undefined) {
          const normalizedDomain = normalizeCustomDomain(patch.domain.customDomain);
          if (patch.domain.customDomain.trim() && !normalizedDomain) {
            throw badRequest(
              "Domain Settings: custom domain must be a valid hostname without protocol or path (example: docs.example.com).",
            );
          }

          store.settings.domain.customDomain = normalizedDomain;
        }

        if (patch.domain.letsEncryptEmail !== undefined) {
          const normalizedEmail = normalizeLetsEncryptEmail(patch.domain.letsEncryptEmail);
          if (patch.domain.letsEncryptEmail.trim() && !normalizedEmail) {
            throw badRequest("Domain Settings: Let's Encrypt email must be a valid email address.");
          }

          store.settings.domain.letsEncryptEmail = normalizedEmail;
        }
      }

      if (patch.theme) {
        if (patch.theme.lightAccent !== undefined) {
          store.settings.theme.lightAccent = patch.theme.lightAccent.trim();
        }

        if (patch.theme.lightSurfaceAccent !== undefined) {
          store.settings.theme.lightSurfaceAccent = patch.theme.lightSurfaceAccent.trim();
        }

        if (patch.theme.darkAccent !== undefined) {
          store.settings.theme.darkAccent = patch.theme.darkAccent.trim();
        }

        if (patch.theme.darkSurfaceAccent !== undefined) {
          store.settings.theme.darkSurfaceAccent = patch.theme.darkSurfaceAccent.trim();
        }

        if (patch.theme.customCss !== undefined) {
          store.settings.theme.customCss = patch.theme.customCss;
        }
      }

      if (patch.github) {
        if (patch.github.owner !== undefined) {
          const nextOwner = patch.github.owner.trim();
          store.settings.github.owner = nextOwner;
        }

        if (patch.github.repo !== undefined) {
          const nextRepo = patch.github.repo.trim();
          store.settings.github.repo = nextRepo;
        }

        if (patch.github.branch !== undefined) {
          const nextBranch = patch.github.branch.trim() || "main";
          store.settings.github.branch = nextBranch;
        }

        if (patch.github.docsPath !== undefined) {
          const nextDocsPath = patch.github.docsPath.trim() || "docs";
          store.settings.github.docsPath = nextDocsPath;
        }

        if (patch.github.token !== undefined) {
          const nextToken = patch.github.token.trim();
          if (!nextToken) {
            store.settings.github.tokenEncrypted = null;
          } else if (decryptStoredSecret(store.settings.github.tokenEncrypted) !== nextToken) {
            store.settings.github.tokenEncrypted = encryptSecret(nextToken);
          }
        }
      }

      if (patch.aiChat) {
        if (patch.aiChat.enabled !== undefined) {
          store.settings.aiChat.enabled = patch.aiChat.enabled;
        }

        if (patch.aiChat.assistantName !== undefined) {
          store.settings.aiChat.assistantName = normalizeAiAssistantName(patch.aiChat.assistantName);
        }

        if (patch.aiChat.avatarUrl !== undefined) {
          store.settings.aiChat.avatarUrl = normalizeAiChatAvatarUrl(patch.aiChat.avatarUrl);
        }

        if (patch.aiChat.headerSubtitle !== undefined) {
          store.settings.aiChat.headerSubtitle = normalizeAiChatHeaderSubtitle(patch.aiChat.headerSubtitle);
        }

        if (patch.aiChat.welcomeMessage !== undefined) {
          store.settings.aiChat.welcomeMessage = normalizeAiChatWelcomeMessage(patch.aiChat.welcomeMessage);
        }

        if (patch.aiChat.openRouterModel !== undefined) {
          store.settings.aiChat.openRouterModel = patch.aiChat.openRouterModel.trim();
        }

        if (patch.aiChat.systemPrompt !== undefined) {
          if (patch.aiChat.systemPrompt.trim() && !patch.aiChat.systemPrompt.includes(AI_CHAT_DOCS_PLACEHOLDER)) {
            throw badRequest(`AI Chat: system prompt must include the ${AI_CHAT_DOCS_PLACEHOLDER} placeholder.`);
          }

          store.settings.aiChat.systemPrompt = normalizeAiChatSystemPromptTemplate(patch.aiChat.systemPrompt);
        }

        if (patch.aiChat.openRouterApiKey !== undefined) {
          const nextApiKey = patch.aiChat.openRouterApiKey.trim();
          if (!nextApiKey) {
            store.settings.openRouter.apiKeyEncrypted = null;
          } else if (decryptStoredSecret(store.settings.openRouter.apiKeyEncrypted) !== nextApiKey) {
            store.settings.openRouter.apiKeyEncrypted = encryptSecret(nextApiKey);
          }
        }
      }

      if (patch.openRouter?.apiKey !== undefined) {
        const nextApiKey = patch.openRouter.apiKey.trim();
        if (!nextApiKey) {
          store.settings.openRouter.apiKeyEncrypted = null;
        } else if (decryptStoredSecret(store.settings.openRouter.apiKeyEncrypted) !== nextApiKey) {
          store.settings.openRouter.apiKeyEncrypted = encryptSecret(nextApiKey);
        }
      }

      if (patch.autoTranslate) {
        if (patch.autoTranslate.enabled !== undefined) {
          const nextEnabled = patch.autoTranslate.enabled;
          if (store.settings.autoTranslate.enabled !== nextEnabled) {
            autoTranslateSettingLogs.push(() => {
              logAutoTranslateInfo(nextEnabled ? "Auto-translate enabled" : "Auto-translate disabled");
            });
          }
          store.settings.autoTranslate.enabled = nextEnabled;
        }

        if (patch.autoTranslate.openRouterModel !== undefined) {
          const previousModel = store.settings.autoTranslate.openRouterModel;
          const nextModel = normalizeAutoTranslateOpenRouterModel(
            patch.autoTranslate.openRouterModel,
          );
          if (previousModel !== nextModel) {
            autoTranslateSettingLogs.push(() => {
              logAutoTranslateInfo("Auto-translate model changed", {
                previousModel,
                nextModel,
              });
            });
          }
          store.settings.autoTranslate.openRouterModel = nextModel;
        }

        if (patch.autoTranslate.requestTimeoutMs !== undefined) {
          store.settings.autoTranslate.requestTimeoutMs = normalizeAutoTranslateRequestTimeoutMs(
            patch.autoTranslate.requestTimeoutMs,
          );
        }

        const localizationPathPatch = patch.autoTranslate.localizationPath ?? patch.autoTranslate.directory;
        if (localizationPathPatch !== undefined) {
          const nextLocalizationPath = normalizeLocalizationPath(localizationPathPatch);
          store.settings.autoTranslate.localizationPath = nextLocalizationPath;
        }

        if (patch.autoTranslate.languages !== undefined) {
          const previousLanguages = store.settings.autoTranslate.languages;
          const previousLanguageMap = autoTranslateLanguageMap(previousLanguages);
          const nextLanguages = normalizeAutoTranslateLanguages(patch.autoTranslate.languages);
          const nextLanguageMap = autoTranslateLanguageMap(nextLanguages);

          for (const [key, nextLanguage] of nextLanguageMap) {
            if (isDefaultAutoTranslateLanguageCode(nextLanguage.code) || previousLanguageMap.has(key)) {
              continue;
            }

            autoTranslateSettingLogs.push(() => {
              logAutoTranslateInfo("Auto-translate language added", {
                language: formatAutoTranslateLanguageForLog(nextLanguage),
              });
            });
          }

          for (const [key, previousLanguage] of previousLanguageMap) {
            if (isDefaultAutoTranslateLanguageCode(previousLanguage.code) || nextLanguageMap.has(key)) {
              continue;
            }

            autoTranslateSettingLogs.push(() => {
              logAutoTranslateInfo("Auto-translate language removed", {
                language: formatAutoTranslateLanguageForLog(previousLanguage),
              });
            });
          }

          for (const [key, nextLanguage] of nextLanguageMap) {
            const previousLanguage = previousLanguageMap.get(key);
            if (
              !previousLanguage ||
              isDefaultAutoTranslateLanguageCode(nextLanguage.code) ||
              previousLanguage.name === nextLanguage.name
            ) {
              continue;
            }

            autoTranslateSettingLogs.push(() => {
              logAutoTranslateInfo("Auto-translate language renamed", {
                language: formatAutoTranslateLanguageForLog(nextLanguage),
                previousName: previousLanguage.name,
              });
            });
          }

          store.settings.autoTranslate.languages = nextLanguages;
        }
      }

      if (store.settings.aiChat.enabled) {
        if (!store.settings.aiChat.systemPrompt.includes(AI_CHAT_DOCS_PLACEHOLDER)) {
          throw badRequest(`AI Chat: system prompt must include the ${AI_CHAT_DOCS_PLACEHOLDER} placeholder.`);
        }

        if (!store.settings.aiChat.openRouterModel.trim()) {
          throw badRequest("AI Chat: OpenRouter model is required when AI chat is enabled.");
        }

        if (!store.settings.openRouter.apiKeyEncrypted) {
          throw badRequest("AI Chat: OpenRouter API key is required when AI chat is enabled.");
        }
      }

      if (store.settings.autoTranslate.enabled) {
        if (!store.settings.autoTranslate.openRouterModel.trim()) {
          throw badRequest("Page Localization: OpenRouter model is required when automatic translation updates are enabled.");
        }

        if (!store.settings.openRouter.apiKeyEncrypted) {
          throw badRequest("Page Localization: OpenRouter API key is required when automatic translation updates are enabled.");
        }
      }
    });

    setDocsCacheTtlMs(updatedStore.settings.docsCacheTtlMs);
    autoTranslateSettingLogs.forEach((writeLog) => writeLog());

    return NextResponse.json({
      settings: getPublicSettings(updatedStore.settings),
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
