import { NextResponse, type NextRequest } from "next/server";

import { getAdminSessionSecurityState } from "@/lib/admin-session-security";
import { ADMIN_USERNAME, getRequestSession, verifySessionToken, type AuthSession } from "@/lib/auth";
import { getStoreFresh } from "@/lib/store";

export const getActiveSession = async (session: AuthSession | null): Promise<AuthSession | null> => {
  if (!session) {
    return null;
  }

  if (session.role === "admin") {
    if (session.username !== ADMIN_USERNAME || !session.adminSessionEpoch) {
      return null;
    }

    const security = await getAdminSessionSecurityState();
    return session.adminSessionEpoch === security.sessionEpoch ? session : null;
  }

  const store = await getStoreFresh();
  const account = store.moderators.find((moderator) => moderator.username === session.username);
  return account ? session : null;
};

export const getActiveSessionForToken = async (token: string): Promise<AuthSession | null> =>
  getActiveSession(await verifySessionToken(token));

export const getActiveRequestSession = async (request: NextRequest): Promise<AuthSession | null> =>
  getActiveSession(await getRequestSession(request));

export const requireEditorAccountRequest = async (request: NextRequest): Promise<NextResponse | null> => {
  const session = await getActiveRequestSession(request);
  return session ? null : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
};

export const requireAdminRequest = async (request: NextRequest): Promise<NextResponse | null> => {
  const session = await getActiveRequestSession(request);
  return session?.role === "admin" ? null : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
};
