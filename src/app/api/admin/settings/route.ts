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
import { requireAdminRequest } from "@/lib/auth";
import { MAX_DOCS_CACHE_TTL_MS, MIN_DOCS_CACHE_TTL_MS, setDocsCacheTtlMs } from "@/lib/cache";
import { normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import { encryptSecret } from "@/lib/encryption";
import { clearGitHubDocsCache } from "@/lib/github";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { normalizeStartPage } from "@/lib/start-page";
import { getPublicSettings, getStore, updateStore } from "@/lib/store";

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
  })
  .strict();

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
          store.settings.github.owner = patch.github.owner.trim();
        }

        if (patch.github.repo !== undefined) {
          store.settings.github.repo = patch.github.repo.trim();
        }

        if (patch.github.branch !== undefined) {
          store.settings.github.branch = patch.github.branch.trim() || "main";
        }

        if (patch.github.docsPath !== undefined) {
          store.settings.github.docsPath = patch.github.docsPath.trim() || "docs";
        }

        if (patch.github.token !== undefined) {
          store.settings.github.tokenEncrypted = patch.github.token.trim()
            ? encryptSecret(patch.github.token.trim())
            : null;
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

          store.settings.aiChat.systemPrompt = normalizeAiChatSystemPromptTemplate(
            patch.aiChat.systemPrompt,
            store.settings.aiChat.assistantName,
          );
        }

        if (patch.aiChat.openRouterApiKey !== undefined) {
          store.settings.aiChat.openRouterApiKeyEncrypted = patch.aiChat.openRouterApiKey.trim()
            ? encryptSecret(patch.aiChat.openRouterApiKey.trim())
            : null;
        }
      }

      if (store.settings.aiChat.enabled) {
        if (!store.settings.aiChat.systemPrompt.includes(AI_CHAT_DOCS_PLACEHOLDER)) {
          throw badRequest(`AI Chat: system prompt must include the ${AI_CHAT_DOCS_PLACEHOLDER} placeholder.`);
        }

        if (!store.settings.aiChat.openRouterModel.trim()) {
          throw badRequest("AI Chat: OpenRouter model is required when AI chat is enabled.");
        }

        if (!store.settings.aiChat.openRouterApiKeyEncrypted) {
          throw badRequest("AI Chat: OpenRouter API key is required when AI chat is enabled.");
        }
      }
    });

    setDocsCacheTtlMs(updatedStore.settings.docsCacheTtlMs);
    clearGitHubDocsCache();

    return NextResponse.json({
      settings: getPublicSettings(updatedStore.settings),
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
