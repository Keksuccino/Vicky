import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { MAX_DOCS_CACHE_TTL_MS, MIN_DOCS_CACHE_TTL_MS, setDocsCacheTtlMs } from "@/lib/cache";
import { encryptSecret } from "@/lib/encryption";
import { clearGitHubDocsCache } from "@/lib/github";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { getPublicSettings, getStore, updateStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const settingsPatchSchema = z
  .object({
    siteTitle: z.string().min(1).optional(),
    siteDescription: z.string().min(1).optional(),
    docsIcon: z
      .object({
        png16Url: z.string().optional(),
        png32Url: z.string().optional(),
        png180Url: z.string().optional(),
      })
      .optional(),
    docsCacheTtlMs: z.coerce.number().int().min(MIN_DOCS_CACHE_TTL_MS).max(MAX_DOCS_CACHE_TTL_MS).optional(),
    activeThemeId: z.string().min(1).optional(),
    github: z
      .object({
        owner: z.string().optional(),
        repo: z.string().optional(),
        branch: z.string().optional(),
        docsPath: z.string().optional(),
        token: z.string().optional(),
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
      themes: store.themes,
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

      if (patch.activeThemeId !== undefined) {
        const exists = store.themes.some((theme) => theme.id === patch.activeThemeId);
        if (!exists) {
          throw badRequest("activeThemeId does not match any existing theme.");
        }
        store.settings.activeThemeId = patch.activeThemeId;
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
    });

    setDocsCacheTtlMs(updatedStore.settings.docsCacheTtlMs);
    clearGitHubDocsCache();

    return NextResponse.json({
      settings: getPublicSettings(updatedStore.settings),
      themes: updatedStore.themes,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
