import { NextResponse, type NextRequest } from "next/server";

import { getActiveRequestSession } from "@/lib/moderators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await getActiveRequestSession(request);

  return NextResponse.json({
    authenticated: Boolean(session),
    role: session?.role ?? null,
    username: session?.username ?? null,
  });
};
