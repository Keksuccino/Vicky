import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { NextResponse, type NextRequest } from "next/server";

import { requireAdminRequest } from "@/lib/active-auth";
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
type CustomDomainHttpPolicy = "application" | "maintenance" | "redirect";

type CertificateInspection = {
  certificateState: CertificateState;
  certificatePresent: boolean;
  certificateValidForDomain: boolean | null;
  certificateExpiresAt: string | null;
};

type RuntimeStatusSnapshot = {
  updatedAt?: string;
  phase?: string;
  domain?: {
    customDomain?: string;
    enabled?: boolean;
  };
  refresh?: {
    lastFailedAt?: string | null;
    lastErrorMessage?: string | null;
  };
  servers?: {
    httpsAvailable?: boolean;
  };
  retry?: {
    nextAttemptAt?: string | null;
  };
  certificate?: {
    expiresAt?: string | null;
    lastIssueFailedAt?: string | null;
    lastIssueErrorMessage?: string | null;
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
      domain: {
        customDomain: asOptionalString(asRecord(payload.domain).customDomain) ?? undefined,
        enabled: asRecord(payload.domain).enabled === true,
      },
      refresh: {
        lastFailedAt: asOptionalString(asRecord(payload.refresh).lastFailedAt),
        lastErrorMessage: asOptionalString(asRecord(payload.refresh).lastErrorMessage),
      },
      servers: {
        httpsAvailable: asRecord(payload.servers).httpsAvailable === true,
      },
      retry: {
        nextAttemptAt: asOptionalString(asRecord(payload.retry).nextAttemptAt),
      },
      certificate: {
        expiresAt: asOptionalString(asRecord(payload.certificate).expiresAt),
        lastIssueFailedAt: asOptionalString(asRecord(payload.certificate).lastIssueFailedAt),
        lastIssueErrorMessage: asOptionalString(asRecord(payload.certificate).lastIssueErrorMessage),
      },
    };
  } catch {
    // Runtime status is supplementary. Certificate inspection below remains available if
    // the private snapshot is missing, invalid, or temporarily inaccessible during startup.
    return null;
  }
};

const inspectCertificate = (privateKeyPem: string, certPem: string, domain: string): CertificateInspection => {
  try {
    tls.createSecureContext({ key: privateKeyPem, cert: certPem, minVersion: "TLSv1.2" });
    const certificate = new X509Certificate(certPem);
    const validFromMs = Date.parse(certificate.validFrom);
    const validToMs = Date.parse(certificate.validTo);
    const hasValidRange = Number.isFinite(validFromMs) && Number.isFinite(validToMs);
    const certificateExpiresAt = Number.isFinite(validToMs) ? new Date(validToMs).toISOString() : null;
    const certificateValidForDomain = Boolean(certificate.checkHost(domain));

    if (!hasValidRange || validFromMs > Date.now()) {
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
  httpsAvailable: boolean,
): string => {
  if (!configured) {
    return buildStatusMessage(false, certificateState);
  }

  const phase = runtimeStatus.phase?.trim().toLowerCase();
  const lastError = runtimeStatus.refresh?.lastErrorMessage?.trim();
  const nextRetryAt = runtimeStatus.retry?.nextAttemptAt?.trim();
  const lastIssueError = runtimeStatus.certificate?.lastIssueErrorMessage?.trim();

  if (!httpsAvailable) {
    if (phase === "backoff" && nextRetryAt) {
      return `HTTPS is unavailable. Custom-domain HTTP requests are returning a fail-closed maintenance response; certificate issuance will retry at ${nextRetryAt}. Last error: ${lastIssueError ?? lastError ?? "unknown"}.`;
    }

    if (phase === "error" && lastError) {
      const retryDetail = nextRetryAt ? ` Automatic recovery will retry at ${nextRetryAt}.` : "";
      return `HTTPS is unavailable and custom-domain HTTP requests are returning a fail-closed maintenance response.${retryDetail} Runtime error: ${lastError}.`;
    }

    if (phase === "refreshing" || phase === "starting") {
      return "HTTPS is being provisioned. Custom-domain HTTP requests are returning a fail-closed maintenance response until a valid certificate is active.";
    }

    return "HTTPS is unavailable. Custom-domain HTTP requests are returning a fail-closed maintenance response instead of application content.";
  }

  if (nextRetryAt && runtimeStatus.certificate?.lastIssueFailedAt && lastIssueError) {
    return `HTTPS remains available with the current valid certificate. Renewal failed and will retry at ${nextRetryAt}. Last error: ${lastIssueError}.`;
  }

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
        certificateInspection = inspectCertificate(privateKeyPem, certificatePem, customDomain);
      }
    }

    const source = runtimeStatus ? "runtime" : "best-effort";
    const runtimeCertificateExpiresAt = runtimeStatus?.certificate?.expiresAt ?? null;
    const certificateExpiresAt = certificateInspection.certificateExpiresAt ?? runtimeCertificateExpiresAt;
    const runtimeCertificateExpiresAtMs = Date.parse(runtimeCertificateExpiresAt ?? "");
    const runtimeDomainMatches = runtimeStatus?.domain?.enabled === true && runtimeStatus.domain.customDomain === customDomain;
    const httpsAvailable = Boolean(configured && runtimeStatus?.servers?.httpsAvailable && runtimeDomainMatches && Number.isFinite(runtimeCertificateExpiresAtMs) && runtimeCertificateExpiresAtMs > Date.now());
    const customDomainHttpPolicy: CustomDomainHttpPolicy = configured ? (httpsAvailable ? "redirect" : "maintenance") : "application";
    const checkedAt = runtimeStatus?.updatedAt ?? new Date().toISOString();
    const message = runtimeStatus
      ? buildRuntimeMessage(configured, certificateInspection.certificateState, runtimeStatus, httpsAvailable)
      : configured
        ? `Live SSL runtime status is unavailable; custom-domain HTTP policy is treated as fail-closed. ${buildStatusMessage(true, certificateInspection.certificateState)}`
        : buildStatusMessage(false, certificateInspection.certificateState);

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
        httpsAvailable,
        customDomainHttpPolicy,
        checkedAt,
        message,
      },
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
