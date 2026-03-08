import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (): Promise<NextResponse> => {
  try {
    const store = await getStore();

    return NextResponse.json({
      settings: {
        siteTitle: store.settings.siteTitle,
        siteDescription: store.settings.siteDescription,
        footerText: store.settings.footerText,
        startPage: store.settings.startPage,
        siteTitleGradient: {
          from: store.settings.siteTitleGradient.from,
          to: store.settings.siteTitleGradient.to,
        },
        docsIcon: {
          png16Url: store.settings.docsIcon.png16Url,
          png32Url: store.settings.docsIcon.png32Url,
          png180Url: store.settings.docsIcon.png180Url,
        },
        domain: {
          customDomain: store.settings.domain.customDomain,
        },
        theme: {
          useSharedAccent: store.settings.theme.useSharedAccent,
          sharedAccent: store.settings.theme.sharedAccent,
          lightAccent: store.settings.theme.lightAccent,
          darkAccent: store.settings.theme.darkAccent,
          customCss: store.settings.theme.customCss,
        },
      },
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
