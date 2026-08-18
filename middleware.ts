import { NextResponse, type NextRequest } from "next/server";

import { ADMIN_COOKIE_NAME, verifySessionToken, type AuthSession } from "@/lib/auth";

const LOGIN_PAGE_PATH = "/admin/login";
const LOGIN_API_PATH = "/api/auth/login";

type RequiredAccess = "admin" | "editor";

const isEditorApiPath = (pathname: string): boolean => pathname === "/api/admin/docs";

const getRequiredAccess = (pathname: string): RequiredAccess | null => {
  if (pathname.startsWith("/api/admin/")) {
    return isEditorApiPath(pathname) ? "editor" : "admin";
  }

  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return pathname === LOGIN_PAGE_PATH ? null : "admin";
  }

  if (pathname === "/editor" || pathname.startsWith("/editor/")) {
    return "editor";
  }

  return null;
};

const isAllowedWithoutSession = (pathname: string): boolean => pathname === LOGIN_PAGE_PATH || pathname === LOGIN_API_PATH;

const unauthorizedApiResponse = (): NextResponse =>
  NextResponse.json(
    {
      error: "Unauthorized",
    },
    { status: 401 },
  );

const isAuthorized = (session: AuthSession | null, requiredAccess: RequiredAccess): boolean => {
  if (!session) {
    return false;
  }

  return requiredAccess === "editor" || session.role === "admin";
};

export const middleware = async (request: NextRequest): Promise<NextResponse> => {
  const { pathname, search } = request.nextUrl;
  const requiredAccess = getRequiredAccess(pathname);

  if (!requiredAccess || isAllowedWithoutSession(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(ADMIN_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (isAuthorized(session, requiredAccess)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/admin/")) {
    return unauthorizedApiResponse();
  }

  const loginSearch = new URLSearchParams({ next: `${pathname}${search}` });
  return new NextResponse(null, { status: 307, headers: { Location: `${LOGIN_PAGE_PATH}?${loginSearch}` } });
};

export const config = {
  matcher: ["/admin/:path*", "/editor/:path*", "/api/admin/:path*", "/docs/:path*"],
};
