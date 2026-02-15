import { NextResponse, type NextRequest } from "next/server";

import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from "@/lib/auth";

const LOGIN_PAGE_PATH = "/admin/login";
const LOGIN_API_PATH = "/api/auth/login";

const isProtectedPath = (pathname: string): boolean => {
  if (pathname.startsWith("/api/admin/")) {
    return true;
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return pathname !== LOGIN_PAGE_PATH;
  }

  if (pathname === "/editor" || pathname.startsWith("/editor/")) {
    return true;
  }

  return false;
};

const isAllowedWithoutSession = (pathname: string): boolean => pathname === LOGIN_PAGE_PATH || pathname === LOGIN_API_PATH;

const unauthorizedApiResponse = (): NextResponse =>
  NextResponse.json(
    {
      error: "Unauthorized",
    },
    { status: 401 },
  );

export const middleware = async (request: NextRequest): Promise<NextResponse> => {
  const { pathname } = request.nextUrl;

  if (!isProtectedPath(pathname) || isAllowedWithoutSession(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(ADMIN_COOKIE_NAME)?.value;

  if (token && (await verifyAdminSessionToken(token))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/admin/")) {
    return unauthorizedApiResponse();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = LOGIN_PAGE_PATH;
  loginUrl.searchParams.set("next", pathname);

  return NextResponse.redirect(loginUrl);
};

export const config = {
  matcher: ["/admin/:path*", "/editor/:path*", "/api/admin/:path*"],
};
