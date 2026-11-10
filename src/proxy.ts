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

/**
 * Guards the admin panel, the editor, and the admin API before any route renders (Next.js `proxy`
 * convention, which always runs in the Node.js runtime). Route handlers and the admin/editor pages
 * check the session again themselves; this is the first of the two layers, not the only one.
 */
export const proxy = async (request: NextRequest): Promise<NextResponse> => {
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

  // Next's proxy adapter requires an absolute Location (a relative one fails the request with
  // `Invalid URL`) and turns every redirect to the origin of the request URL into a relative
  // Location. That origin is Next's own listener (for example http://0.0.0.0:3000), never taken
  // from client headers, so visitors receive `/admin/login?next=...` and stay on the public origin
  // they requested, including behind a proxy, a CDN, or a custom domain. Keep the redirect on
  // `request.nextUrl`; a URL built from any other origin would reach visitors unchanged.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = LOGIN_PAGE_PATH;
  loginUrl.search = new URLSearchParams({ next: `${pathname}${search}` }).toString();
  return NextResponse.redirect(loginUrl);
};

export const config = {
  matcher: ["/admin/:path*", "/editor/:path*", "/api/admin/:path*"],
};
