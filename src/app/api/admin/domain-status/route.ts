import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/auth";
import { isSslDomainConfigured, normalizeCustomDomain, normalizeLetsEncryptEmail } from "@/lib/domain-settings";
import { errorResponse } from "@/lib/http";
import { ensurePrivateFile } from "@/lib/runtime-file-security.mjs";
import { isCurrentRuntimeSslStatusSnapshot, readPrivateRuntimeSslStatusSnapshot } from "@/lib/runtime-ssl-status.mjs";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SSL_STORAGE_DIR = path.join(process.cwd(), "data", "ssl");
const SSL_STORAGE_DIR = process.env.WIKI_SSL_STORAGE_DIR ?? DEFAULT_SSL_STORAGE_DIR;
const SSL_STATUS_FILE_PATH = process.env.SSL_STATUS_FILE_PATH ?? path.join(SSL_STORAGE_DIR, "runtime-ssl-status.json");
const EXPIRING_SOON_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
    await ensurePrivateFile(filePath);
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

const readRuntimeStatusSnapshot = async (): Promise<RuntimeStatusSnapshot | null> => {
  try {
    const parsed = await readPrivateRuntimeSslStatusSnapshot(SSL_STATUS_FILE_PATH);
    if (!parsed || !isCurrentRuntimeSslStatusSnapshot(parsed, process.env.VICKY_INTERNAL_SSL_RUNTIME_INSTANCE_ID)) {
      return null;
    }

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
    // Runtime status is supplementary. Certificate inspection below remains available if
    // the private snapshot is missing, invalid, or temporarily inaccessible during startup.
    return null;
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
    const runtimeStatus = await readRuntimeStatusSnapshot();

    let certificateInspection = MISSING_CERTIFICATE;

    if (configured) {
      // Certificate storage is mutable runtime state and may live outside the project. Never trace private keys into the build output.
      const certificateDirectory = path.join(/*turbopackIgnore: true*/ SSL_STORAGE_DIR, customDomain);
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
