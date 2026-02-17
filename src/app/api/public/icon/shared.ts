import { NextResponse, type NextRequest } from "next/server";

import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

type IconSize = "16" | "32" | "180";

const resolveIconUrl = (size: IconSize, settings: Awaited<ReturnType<typeof getStore>>["settings"]): string => {
  if (size === "16") {
    return settings.docsIcon.png16Url;
  }
  if (size === "32") {
    return settings.docsIcon.png32Url;
  }
  return settings.docsIcon.png180Url;
};

const toSafeTargetUrl = (rawUrl: string, request: NextRequest): string | null => {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const resolved = new URL(trimmed, request.nextUrl.origin);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }

    return resolved.toString();
  } catch {
    return null;
  }
};

export const handleIconRequest = async (request: NextRequest, size: IconSize): Promise<NextResponse> => {
  try {
    const store = await getStore();
    const rawUrl = resolveIconUrl(size, store.settings);
    const target = toSafeTargetUrl(rawUrl, request);

    if (!target) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.redirect(target, {
      status: 307,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
