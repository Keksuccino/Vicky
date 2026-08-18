import { isIP } from "node:net";

import { isAuthenticatedInternalRequestContext } from "./request-origin-policy.mjs";

export const INTERNAL_CLIENT_IP_HEADER = "x-vicky-client-ip";

const TRUST_PROXY_CLIENT_IP_HEADERS_ENV = "AUTH_TRUST_PROXY_HEADERS";
const TRUSTED_PROXY_IPS_ENV = "AUTH_TRUSTED_PROXY_IPS";
const MAX_IP_LENGTH = 45;
const MAX_TRUSTED_PROXY_IPS = 64;

/** @type {string | undefined} */
let cachedTrustedProxyConfig;
/** @type {Set<string>} */
let cachedTrustedProxyIps = new Set();
let hasCachedTrustedProxyConfig = false;

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function parseEnabled(value) {
  return String(value ?? "").trim().toLowerCase() === "true";
}

/**
 * Canonicalizes one exact IP address. Ports, brackets, zone identifiers, whitespace,
 * forwarding chains, and truncated values are rejected. IPv4-mapped IPv6 is collapsed
 * to IPv4 so the same peer cannot acquire two independent rate-limit identities.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeClientIp(value) {
  if (typeof value !== "string" || !value || value.length > MAX_IP_LENGTH || value !== value.trim()) {
    return null;
  }

  const version = isIP(value);
  if (version === 4) {
    return value.split(".").map((octet) => String(Number.parseInt(octet, 10))).join(".");
  }
  if (version !== 6) {
    return null;
  }

  try {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1).toLowerCase();
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped) {
      return canonical;
    }

    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
  } catch {
    // WHATWG URL parsing deliberately rejects scoped IPv6 forms such as fe80::1%lo0.
    return null;
  }
}

/**
 * @param {{ get: (name: string) => string | null }} headers
 * @param {string} name
 * @returns {string | null}
 */
function getHeader(headers, name) {
  const value = headers.get(name);
  return typeof value === "string" ? value : null;
}

/**
 * Forwarded client-IP headers use overwrite-only semantics: a trusted ingress may set
 * one exact address, never a chain. If it sets both supported headers, they must agree.
 *
 * @param {{ get: (name: string) => string | null }} headers
 * @param {boolean} trustedBoundary
 * @returns {string | null}
 */
export function resolveTrustedForwardedClientIp(headers, trustedBoundary) {
  if (!trustedBoundary) {
    return null;
  }

  const forwardedForValue = getHeader(headers, "x-forwarded-for");
  const realIpValue = getHeader(headers, "x-real-ip");
  if (forwardedForValue === null && realIpValue === null) {
    return null;
  }

  const forwardedFor = forwardedForValue === null ? null : normalizeClientIp(forwardedForValue);
  const realIp = realIpValue === null ? null : normalizeClientIp(realIpValue);
  if ((forwardedForValue !== null && !forwardedFor) || (realIpValue !== null && !realIp)) {
    return null;
  }
  if (forwardedFor && realIp && forwardedFor !== realIp) {
    return null;
  }

  return forwardedFor ?? realIp;
}

/**
 * The allowlist is fail-closed: every comma-separated entry must be one exact IP, and
 * invalid, empty, or oversized configurations trust no proxy.
 *
 * @returns {Set<string>}
 */
function getTrustedProxyIps() {
  const configured = process.env[TRUSTED_PROXY_IPS_ENV];
  if (hasCachedTrustedProxyConfig && configured === cachedTrustedProxyConfig) {
    return cachedTrustedProxyIps;
  }

  hasCachedTrustedProxyConfig = true;
  cachedTrustedProxyConfig = configured;
  if (!configured) {
    cachedTrustedProxyIps = new Set();
    return cachedTrustedProxyIps;
  }

  const entries = configured.split(",").map((entry) => entry.trim());
  if (entries.length > MAX_TRUSTED_PROXY_IPS || entries.some((entry) => !entry)) {
    cachedTrustedProxyIps = new Set();
    return cachedTrustedProxyIps;
  }

  const normalized = entries.map((entry) => normalizeClientIp(entry));
  cachedTrustedProxyIps = normalized.some((entry) => !entry) ? new Set() : new Set(normalized);
  return cachedTrustedProxyIps;
}

/**
 * @param {unknown} peerIp
 * @returns {boolean}
 */
export function isTrustedProxyClientIpPeer(peerIp) {
  if (!parseEnabled(process.env[TRUST_PROXY_CLIENT_IP_HEADERS_ENV])) {
    return false;
  }

  const normalizedPeerIp = normalizeClientIp(peerIp);
  return Boolean(normalizedPeerIp && getTrustedProxyIps().has(normalizedPeerIp));
}

/**
 * @param {{ headers: { get: (name: string) => string | null }, ip?: string }} request
 * @returns {string | null}
 */
function resolveAuthenticatedInternalClientIp(request) {
  if (!isAuthenticatedInternalRequestContext(request.headers)) {
    return null;
  }

  return normalizeClientIp(getHeader(request.headers, INTERNAL_CLIENT_IP_HEADER));
}

/**
 * Resolves a client IP under one strict policy. Trusted forwarded data wins only when
 * the authenticated peer is explicitly allowlisted; otherwise private included-server
 * socket context wins over an optional framework-provided direct IP.
 *
 * Current NextRequest versions do not expose `ip`, but retaining the final direct-IP
 * fallback supports runtimes that add a non-header peer property without trusting XFF.
 *
 * @param {{ headers: { get: (name: string) => string | null }, ip?: string }} request
 * @returns {string | null}
 */
export function resolveClientIp(request) {
  const internalIp = resolveAuthenticatedInternalClientIp(request);
  const directIp = normalizeClientIp(request.ip);
  const authenticatedPeerIp = internalIp ?? directIp;
  const forwardedIp = resolveTrustedForwardedClientIp(request.headers, isTrustedProxyClientIpPeer(authenticatedPeerIp));
  return forwardedIp ?? internalIp ?? directIp;
}

/**
 * Compatibility sentinel for consumers that persist or hash an address. Admission
 * controls should treat `unknown` as global-only rather than as a per-client bucket.
 *
 * @param {{ headers: { get: (name: string) => string | null }, ip?: string }} request
 * @returns {string}
 */
export function getClientIp(request) {
  return resolveClientIp(request) ?? "unknown";
}
