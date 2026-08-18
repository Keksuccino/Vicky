import { randomUUID } from "node:crypto";

import { getStoreFresh, updateStore } from "@/lib/store";

export type AdminSessionSecurityState = {
  sessionEpoch: string;
  credentialFingerprint: string;
};

export const getAdminSessionSecurityState = async (): Promise<AdminSessionSecurityState> => {
  const store = await getStoreFresh();
  return { ...store.adminSessionSecurity };
};

/**
 * Rotates the durable epoch under the store's in-process queue and cross-process
 * lock. Tokens issued before this transition fail the next fresh authorization read.
 */
export const revokeAdminSessions = async (): Promise<AdminSessionSecurityState> => {
  let revokedState: AdminSessionSecurityState | null = null;
  await updateStore((store) => {
    store.adminSessionSecurity.sessionEpoch = randomUUID();
    revokedState = { ...store.adminSessionSecurity };
  }, { touchSettings: false });

  if (!revokedState) {
    throw new Error("Built-in admin sessions were not revoked.");
  }

  return revokedState;
};
