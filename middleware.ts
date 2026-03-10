import { NextResponse, type NextRequest } from "next/server";

import { ADMIN_COOKIE_NAME, verifyAdminSessionToken } from "@/lib/auth";

const LOGIN_PAGE_PATH = "/admin/login";
const LOGIN_API_PATH = "/api/auth/login";
const RAW_DOCS_QUERY_PARAM = "raw";
const RAW_DOCS_REWRITE_PREFIX = "/raw-docs";

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

const shouldRewriteToRawDocs = (request: NextRequest): boolean => {
  const { pathname, searchParams } = request.nextUrl;
  if (!pathname.startsWith("/docs/") || !searchParams.has(RAW_DOCS_QUERY_PARAM)) {
    return false;
  }

  const rawValue = searchParams.get(RAW_DOCS_QUERY_PARAM)?.trim().toLowerCase();
  return rawValue !== "0" && rawValue !== "false";
};

const unauthorizedApiResponse = (): NextResponse =>
  NextResponse.json(
    {
      error: "Unauthorized",
    },
    { status: 401 },
  );

export const middleware = async (request: NextRequest): Promise<NextResponse> => {
  const { pathname } = request.nextUrl;

  if (shouldRewriteToRawDocs(request)) {
    const rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = `${RAW_DOCS_REWRITE_PREFIX}${pathname}`;
    rewriteUrl.searchParams.delete(RAW_DOCS_QUERY_PARAM);
    return NextResponse.rewrite(rewriteUrl);
  }

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
  matcher: ["/admin/:path*", "/editor/:path*", "/api/admin/:path*", "/docs/:path*"],
};
