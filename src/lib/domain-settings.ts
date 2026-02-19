import type { DomainSettings } from "@/lib/types";
import { normalizeCustomDomainInput, normalizeEmailInput } from "./domain-normalization.mjs";

export const normalizeCustomDomain = (value: unknown): string => {
  return normalizeCustomDomainInput(value);
};

export const normalizeLetsEncryptEmail = (value: unknown): string => {
  return normalizeEmailInput(value);
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
