import { NextResponse } from "next/server";

import { clearAdminSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = async (): Promise<NextResponse> => {
  const response = NextResponse.json({ authenticated: false });
  clearAdminSessionCookie(response);
  return response;
};
