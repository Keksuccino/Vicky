import { NextResponse, type NextRequest } from "next/server";

import { isAdminRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const authenticated = await isAdminRequest(request);

  return NextResponse.json({
    authenticated,
    role: authenticated ? "admin" : null,
  });
};
