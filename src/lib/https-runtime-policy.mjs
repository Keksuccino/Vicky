export const ACME_HTTP_CHALLENGE_PREFIX = "/.well-known/acme-challenge/";

/**
 * Extracts a comparable hostname from Node's Host header without trusting proxy headers.
 * A trailing DNS root dot is equivalent to the configured hostname and is removed.
 *
 * @param {unknown} headerValue
 * @returns {string}
 */
export function getRequestHostname(headerValue) {
  if (!headerValue) {
    return "";
  }

  const first = String(Array.isArray(headerValue) ? headerValue[0] : headerValue).split(",")[0].trim();
  if (!first) {
    return "";
  }

  if (first.startsWith("[")) {
    const closingBracket = first.indexOf("]");
    if (closingBracket > 1) {
      return first.slice(1, closingBracket).toLowerCase();
    }
  }

  return first.split(":")[0].replace(/\.$/, "").toLowerCase();
}

/**
 * ACME validation is the sole plaintext exception for a configured custom domain.
 * Matching only a non-empty token prevents the challenge directory itself from bypassing
 * the fail-closed policy and reaching application routing.
 *
 * @param {unknown} requestUrl
 * @returns {boolean}
 */
export function isAcmeHttpChallengeRequest(requestUrl) {
  const rawUrl = typeof requestUrl === "string" ? requestUrl : "/";
  const requestPath = rawUrl.split("?")[0];
  return requestPath.startsWith(ACME_HTTP_CHALLENGE_PREFIX) && requestPath.length > ACME_HTTP_CHALLENGE_PREFIX.length;
}

/**
 * Availability describes the certificate actually installed in the live HTTPS listener,
 * not merely certificate files on disk. Time is evaluated for every request so traffic
 * fails closed immediately when a certificate expires between periodic renewal checks.
 *
 * @param {{ certificateDomain?: string, certificateExpiresAtMs?: number, certificateValidFromMs?: number, configuredDomain?: string, httpsListening?: boolean, nowMs?: number }} input
 * @returns {boolean}
 */
export function isHttpsServiceAvailable(input) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  return Boolean(input.httpsListening && input.configuredDomain && input.certificateDomain === input.configuredDomain && Number.isFinite(input.certificateValidFromMs) && input.certificateValidFromMs <= nowMs && Number.isFinite(input.certificateExpiresAtMs) && input.certificateExpiresAtMs > nowMs);
}

/**
 * Central request policy shared by both listeners. Non-custom hosts retain the normal app
 * behavior on HTTP (including localhost/default deployment hosts). Canonical redirects are
 * emitted only when the target HTTPS listener has a currently valid matching certificate.
 *
 * @param {{ configuredDomain?: string, httpsAvailable?: boolean, protocol: "http" | "https", requestHost?: unknown, requestUrl?: unknown }} input
 * @returns {"application" | "challenge" | "maintenance" | "redirect"}
 */
export function decideRuntimeRequestAction(input) {
  if (input.protocol === "http" && isAcmeHttpChallengeRequest(input.requestUrl)) {
    return "challenge";
  }

  const configuredDomain = typeof input.configuredDomain === "string" ? input.configuredDomain : "";
  if (!configuredDomain) {
    return "application";
  }

  const requestedHost = getRequestHostname(input.requestHost);
  const isCustomDomainRequest = requestedHost === configuredDomain;

  if (input.protocol === "http") {
    if (!isCustomDomainRequest) {
      return "application";
    }

    return input.httpsAvailable ? "redirect" : "maintenance";
  }

  if (isCustomDomainRequest) {
    return input.httpsAvailable ? "application" : "maintenance";
  }

  return input.httpsAvailable ? "redirect" : "application";
}

/**
 * Dispatches one HTTP request in security-sensitive order. ACME validation is handled
 * first; custom-domain redirect or maintenance policy is enforced next; only an ordinary
 * application action is allowed to evaluate the optional bearer-protected status route.
 * Keeping that ordering here prevents a newly added special route from bypassing HTTPS.
 *
 * @param {{ configuredDomain?: string, httpsAvailable?: boolean, requestHost?: unknown, requestUrl?: unknown, serveApplication: Function, serveChallenge: Function, serveMaintenance: Function, serveRedirect: Function, serveRuntimeStatus: Function }} input
 * @returns {"application" | "challenge" | "maintenance" | "redirect" | "status"}
 */
export function routeRuntimeHttpRequest(input) {
  const action = decideRuntimeRequestAction({ protocol: "http", configuredDomain: input.configuredDomain, httpsAvailable: input.httpsAvailable, requestHost: input.requestHost, requestUrl: input.requestUrl });

  if (action === "challenge") {
    input.serveChallenge();
    return "challenge";
  }

  if (action === "redirect") {
    input.serveRedirect();
    return "redirect";
  }

  if (action === "maintenance") {
    input.serveMaintenance();
    return "maintenance";
  }

  if (input.serveRuntimeStatus()) {
    return "status";
  }

  input.serveApplication();
  return "application";
}

/**
 * Writes the deliberately static plaintext response used while secure custom-domain
 * service is unavailable. It contains no application data or provider diagnostics.
 *
 * @param {{ end: Function, writeHead: Function }} response
 * @returns {void}
 */
export function writeHttpsMaintenanceResponse(response) {
  const body = "Secure service is temporarily unavailable while HTTPS is being restored. Please try again later.\n";
  const headers = {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Content-Type": "text/plain; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "Retry-After": "300",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  response.writeHead(503, headers);
  response.end(body);
}
