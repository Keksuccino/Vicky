export {
  getClientIp,
  INTERNAL_CLIENT_IP_HEADER,
  isTrustedProxyClientIpPeer,
  normalizeClientIp,
  resolveClientIp,
  resolveTrustedForwardedClientIp,
} from "@/lib/client-ip-policy.mjs";

export type ClientIpRequest = {
  headers: { get: (name: string) => string | null };
  ip?: string;
};
