import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import type { ThemeDefinition, ThemeVariables } from "@/lib/types";
import { badRequest, errorResponse, notFound, parseJsonBody } from "@/lib/http";
import { updateStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    mode: z.enum(["light", "dark"]).optional(),
    variables: z.record(z.string(), z.string()).optional(),
    customCss: z.string().optional(),
  })
  .strict();

const normalizeVariables = (variables: ThemeVariables): ThemeVariables => {
  const entries = Object.entries(variables)
    .map(([rawKey, rawValue]) => {
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (!key || !value) {
        return null;
      }

      return [key.startsWith("--") ? key : `--${key}`, value] as const;
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry));

  if (entries.length === 0) {
    throw badRequest("At least one CSS variable is required.");
  }

  return Object.fromEntries(entries);
};

const sanitizeTheme = (theme: ThemeDefinition): ThemeDefinition => ({
  ...theme,
  name: theme.name.trim(),
  customCss: theme.customCss,
  variables: Object.fromEntries(
    Object.entries(theme.variables)
      .map(([key, value]) => {
        const normalizedKey = key.trim();
        const normalizedValue = value.trim();
        if (!normalizedKey || !normalizedValue) {
          return null;
        }

        return [normalizedKey.startsWith("--") ? normalizedKey : `--${normalizedKey}`, normalizedValue] as const;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry)),
  ),
});

export const PATCH = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { id } = await context.params;
    const body = await parseJsonBody<unknown>(request);
    const payload = patchSchema.parse(body);
    const timestamp = new Date().toISOString();

    let updatedTheme: ThemeDefinition | undefined;

    await updateStore((store) => {
      const theme = store.themes.find((entry) => entry.id === id);
      if (!theme) {
        throw notFound("Theme not found.");
      }

      if (theme.isBuiltin) {
        throw badRequest("Built-in themes cannot be modified.");
      }

      if (payload.name !== undefined) {
        theme.name = payload.name.trim();
      }

      if (payload.mode !== undefined) {
        theme.mode = payload.mode;
      }

      if (payload.variables !== undefined) {
        theme.variables = normalizeVariables(payload.variables);
      }

      if (payload.customCss !== undefined) {
        theme.customCss = payload.customCss;
      }

      theme.updatedAt = timestamp;
      updatedTheme = sanitizeTheme(theme);
    });

    return NextResponse.json({ theme: updatedTheme });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};

export const DELETE = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { id } = await context.params;

    const updatedStore = await updateStore((store) => {
      const index = store.themes.findIndex((entry) => entry.id === id);
      if (index < 0) {
        throw notFound("Theme not found.");
      }

      if (store.themes[index].isBuiltin) {
        throw badRequest("Built-in themes cannot be deleted.");
      }

      store.themes.splice(index, 1);

      if (store.settings.activeThemeId === id) {
        const fallback = store.themes.find((theme) => theme.isBuiltin) ?? store.themes[0];
        if (!fallback) {
          throw badRequest("Cannot delete the last remaining theme.");
        }

        store.settings.activeThemeId = fallback.id;
      }
    });

    return NextResponse.json({
      deletedThemeId: id,
      activeThemeId: updatedStore.settings.activeThemeId,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
