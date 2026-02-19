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
      },
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
