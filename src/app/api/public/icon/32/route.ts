import { type NextRequest, type NextResponse } from "next/server";

import { dynamic, handleIconRequest, runtime } from "@/app/api/public/icon/shared";

export { runtime, dynamic };

export const GET = async (request: NextRequest): Promise<NextResponse> => handleIconRequest(request, "32");
export const HEAD = GET;
