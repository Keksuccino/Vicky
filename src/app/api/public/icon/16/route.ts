import { type NextRequest, type NextResponse } from "next/server";

import { handleIconRequest } from "@/app/api/public/icon/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = async (request: NextRequest): Promise<NextResponse> => handleIconRequest(request, "16");
export const HEAD = GET;
