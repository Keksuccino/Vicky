const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCustomDomainInput(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  const maybeUrl = HOST_SCHEME_REGEX.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(maybeUrl);

    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return "";
    }

    const hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
    if (!hostname || hostname.includes("..")) {
      return "";
    }

    if (!/^[a-z0-9.-]+$/.test(hostname)) {
      return "";
    }

    if (!hostname.includes(".") || !/[a-z]/.test(hostname)) {
      return "";
    }

    return hostname;
  } catch {
    return "";
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEmailInput(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  return EMAIL_REGEX.test(normalized) ? normalized : "";
}
