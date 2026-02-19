import type { DomainSettings } from "@/lib/types";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeHostnameInput = (value: string): string => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  const maybeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsed = new URL(maybeUrl);

    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return "";
    }

    const normalized = parsed.hostname.replace(/\.$/, "").toLowerCase();
    if (!normalized || normalized.includes("..")) {
      return "";
    }

    if (!/^[a-z0-9.-]+$/.test(normalized)) {
      return "";
    }

    if (!/[a-z]/.test(normalized)) {
      return "";
    }

    if (!normalized.includes(".")) {
      return "";
    }

    return normalized;
  } catch {
    return "";
  }
};

export const normalizeCustomDomain = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  return normalizeHostnameInput(value);
};

export const normalizeLetsEncryptEmail = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  return EMAIL_REGEX.test(normalized) ? normalized : "";
};

export const normalizeDomainSettings = (value: unknown, fallback?: DomainSettings): DomainSettings => {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  const customDomain = normalizeCustomDomain(source.customDomain);
  const letsEncryptEmail = normalizeLetsEncryptEmail(source.letsEncryptEmail);

  return {
    customDomain: customDomain || fallback?.customDomain || "",
    letsEncryptEmail: letsEncryptEmail || fallback?.letsEncryptEmail || "",
  };
};

export const isSslDomainConfigured = (domain: DomainSettings): boolean =>
  Boolean(domain.customDomain.trim() && domain.letsEncryptEmail.trim());
