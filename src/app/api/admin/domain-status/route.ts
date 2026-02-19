import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { isSslDomainConfigured, normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import { errorResponse } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SSL_STORAGE_DIR = path.join(process.cwd(), "data", "ssl");
const SSL_STORAGE_DIR = process.env.WIKI_SSL_STORAGE_DIR ?? DEFAULT_SSL_STORAGE_DIR;
const EXPIRING_SOON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RUNTIME_STATUS_ENDPOINT_PATH = "/.well-known/vicky/ssl-status";
const STATUS_REQUEST_TIMEOUT_MS = 2_000;
const HTTP_PORT = (() => {
  const parsed = Number.parseInt(process.env.HTTP_PORT ?? process.env.PORT ?? "3000", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 3000;
})();
const STATUS_ENDPOINT_PATH = (() => {
  const rawPath = (process.env.SSL_STATUS_ENDPOINT_PATH ?? DEFAULT_RUNTIME_STATUS_ENDPOINT_PATH).trim();
  if (!rawPath) {
    return DEFAULT_RUNTIME_STATUS_ENDPOINT_PATH;
  }

  const stripped = rawPath.split("?")[0].split("#")[0];
  const prefixed = stripped.startsWith("/") ? stripped : `/${stripped}`;
  const normalized = path.posix.normalize(prefixed);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
})();
const STATUS_ENDPOINT_BEARER_TOKEN = (process.env.SSL_STATUS_BEARER_TOKEN ?? "").trim();

type CertificateState = "missing" | "valid" | "expiring_soon" | "expired" | "domain_mismatch" | "invalid";

type CertificateInspection = {
  certificateState: CertificateState;
  certificatePresent: boolean;
  certificateValidForDomain: boolean | null;
  certificateExpiresAt: string | null;
};

type RuntimeStatusSnapshot = {
  updatedAt?: string;
  phase?: string;
  refresh?: {
    lastFailedAt?: string | null;
    lastErrorMessage?: string | null;
  };
  retry?: {
    nextAttemptAt?: string | null;
  };
  certificate?: {
    expiresAt?: string | null;
  };
};

const MISSING_CERTIFICATE: CertificateInspection = {
  certificateState: "missing",
  certificatePresent: false,
  certificateValidForDomain: null,
  certificateExpiresAt: null,
};

const readTextFileIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const asOptionalString = (value: unknown): string | null => {
  const valueAsString = asString(value).trim();
  return valueAsString || null;
};

const fetchRuntimeStatusSnapshot = async (): Promise<RuntimeStatusSnapshot | null> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${HTTP_PORT}${STATUS_ENDPOINT_PATH}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: STATUS_ENDPOINT_BEARER_TOKEN ? { Authorization: `Bearer ${STATUS_ENDPOINT_BEARER_TOKEN}` } : undefined,
    });

    if (!response.ok) {
      return null;
    }

    const parsed = (await response.json()) as unknown;
    const payload = asRecord(parsed);

    return {
      updatedAt: asOptionalString(payload.updatedAt) ?? undefined,
      phase: asOptionalString(payload.phase) ?? undefined,
      refresh: {
        lastFailedAt: asOptionalString(asRecord(payload.refresh).lastFailedAt),
        lastErrorMessage: asOptionalString(asRecord(payload.refresh).lastErrorMessage),
      },
      retry: {
        nextAttemptAt: asOptionalString(asRecord(payload.retry).nextAttemptAt),
      },
      certificate: {
        expiresAt: asOptionalString(asRecord(payload.certificate).expiresAt),
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

const inspectCertificate = (certPem: string, domain: string): CertificateInspection => {
  try {
    const certificate = new X509Certificate(certPem);
    const validToMs = Date.parse(certificate.validTo);
    const hasValidExpiry = Number.isFinite(validToMs);
    const certificateExpiresAt = hasValidExpiry ? new Date(validToMs).toISOString() : null;
    const certificateValidForDomain = Boolean(certificate.checkHost(domain));

    if (!hasValidExpiry) {
      return {
        certificateState: "invalid",
        certificatePresent: true,
        certificateValidForDomain: null,
        certificateExpiresAt: null,
      };
    }

    if (!certificateValidForDomain) {
      return {
        certificateState: "domain_mismatch",
        certificatePresent: true,
        certificateValidForDomain: false,
        certificateExpiresAt,
      };
    }

    const msRemaining = validToMs - Date.now();

    if (msRemaining <= 0) {
      return {
        certificateState: "expired",
        certificatePresent: true,
        certificateValidForDomain: true,
        certificateExpiresAt,
      };
    }

    if (msRemaining <= EXPIRING_SOON_WINDOW_MS) {
      return {
        certificateState: "expiring_soon",
        certificatePresent: true,
        certificateValidForDomain: true,
        certificateExpiresAt,
      };
    }

    return {
      certificateState: "valid",
      certificatePresent: true,
      certificateValidForDomain: true,
      certificateExpiresAt,
    };
  } catch {
    return {
      certificateState: "invalid",
      certificatePresent: true,
      certificateValidForDomain: null,
      certificateExpiresAt: null,
    };
  }
};

const buildStatusMessage = (configured: boolean, certificateState: CertificateState): string => {
  if (!configured) {
    return "Automatic SSL is disabled until both custom domain and Let's Encrypt email are set.";
  }

  switch (certificateState) {
    case "valid":
      return "SSL certificate is available and valid for the configured domain.";
    case "expiring_soon":
      return "SSL certificate is valid but nearing expiration; renewal should happen automatically.";
    case "expired":
      return "SSL certificate has expired. Check DNS and runtime logs for renewal failures.";
    case "domain_mismatch":
      return "SSL certificate does not match the configured domain.";
    case "invalid":
      return "Stored SSL certificate could not be parsed.";
    default:
      return "No stored SSL certificate found yet. Runtime may still be provisioning one.";
  }
};

const buildRuntimeMessage = (
  configured: boolean,
  certificateState: CertificateState,
  runtimeStatus: RuntimeStatusSnapshot,
): string => {
  if (!configured) {
    return buildStatusMessage(false, certificateState);
  }

  const phase = runtimeStatus.phase?.trim().toLowerCase();
  const lastError = runtimeStatus.refresh?.lastErrorMessage?.trim();
  const nextRetryAt = runtimeStatus.retry?.nextAttemptAt?.trim();

  if (phase === "backoff" && nextRetryAt) {
    return `SSL renewal is in retry backoff until ${nextRetryAt}. Last error: ${lastError ?? "unknown"}.`;
  }

  if (phase === "error" && lastError) {
    return `SSL runtime reported an error: ${lastError}.`;
  }

  if ((phase === "refreshing" || phase === "starting") && certificateState === "missing") {
    return "SSL runtime is currently provisioning or refreshing the certificate.";
  }

  return buildStatusMessage(true, certificateState);
};

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const unauthorizedResponse = await requireAdminRequest(request);
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const store = await getStore();
    const customDomain = normalizeCustomDomain(store.settings.domain.customDomain);
    const letsEncryptEmail = normalizeLetsEncryptEmail(store.settings.domain.letsEncryptEmail);
    const configured = isSslDomainConfigured({ customDomain, letsEncryptEmail });
    const runtimeStatus = await fetchRuntimeStatusSnapshot();

    let certificateInspection = MISSING_CERTIFICATE;

    if (configured) {
      const certificateDirectory = path.join(SSL_STORAGE_DIR, customDomain);
      const [privateKeyPem, certificatePem] = await Promise.all([
        readTextFileIfExists(path.join(certificateDirectory, "privkey.pem")),
        readTextFileIfExists(path.join(certificateDirectory, "fullchain.pem")),
      ]);

      if (privateKeyPem && certificatePem) {
        certificateInspection = inspectCertificate(certificatePem, customDomain);
      }
    }

    const source = runtimeStatus ? "runtime" : "best-effort";
    const runtimeCertificateExpiresAt = runtimeStatus?.certificate?.expiresAt ?? null;
    const certificateExpiresAt = certificateInspection.certificateExpiresAt ?? runtimeCertificateExpiresAt;
    const checkedAt = runtimeStatus?.updatedAt ?? new Date().toISOString();
    const message = runtimeStatus
      ? buildRuntimeMessage(configured, certificateInspection.certificateState, runtimeStatus)
      : buildStatusMessage(configured, certificateInspection.certificateState);

    return NextResponse.json({
      status: {
        source,
        configured,
        customDomain,
        letsEncryptEmail,
        certificateState: certificateInspection.certificateState,
        certificatePresent: certificateInspection.certificatePresent,
        certificateValidForDomain: certificateInspection.certificateValidForDomain,
        certificateExpiresAt,
        checkedAt,
        message,
      },
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
