import { randomUUID } from "node:crypto";

import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import type { ThemeDefinition, ThemeVariables } from "@/lib/types";
import { badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { getStore, updateStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createThemeSchema = z
  .object({
    name: z.string().min(1),
    mode: z.enum(["light", "dark"]),
    variables: z.record(z.string(), z.string()).default({}),
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

export const GET = async (): Promise<NextResponse> => {
  try {
    const store = await getStore();

    return NextResponse.json({
      themes: store.themes.map(sanitizeTheme),
      activeThemeId: store.settings.activeThemeId,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = await parseJsonBody<unknown>(request);
    const payload = createThemeSchema.parse(body);

    const newThemeId = `theme-${randomUUID()}`;
    const timestamp = new Date().toISOString();

    const updatedStore = await updateStore((store) => {
      const exists = store.themes.some((theme) => theme.id === newThemeId);
      if (exists) {
        throw badRequest("Theme id collision detected. Retry request.");
      }

      store.themes.push({
        id: newThemeId,
        name: payload.name.trim(),
        mode: payload.mode,
        isBuiltin: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        customCss: payload.customCss ?? "",
        variables: normalizeVariables(payload.variables),
      });
    });

    const createdTheme = updatedStore.themes.find((theme) => theme.id === newThemeId);

    return NextResponse.json({
      theme: createdTheme ? sanitizeTheme(createdTheme) : null,
      activeThemeId: updatedStore.settings.activeThemeId,
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
