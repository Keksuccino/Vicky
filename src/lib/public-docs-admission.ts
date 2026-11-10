import { ApiError } from "@/lib/http";
import type { ClientIpRequest } from "@/lib/client-ip-policy";
import { acquirePublicDocsAdmissionPermit, isPublicDocsRequestAdmitted, publicDocsThrottledMessage } from "@/lib/public-docs-limiter.mjs";
import type { AdmissionPermit } from "@/lib/request-admission.mjs";

export { acquirePublicDocsAdmissionPermit, resetPublicDocsAdmissionForTests } from "@/lib/public-docs-limiter.mjs";

export type PublicDocsAdmissionPermit = AdmissionPermit;

/**
 * Runs one public document read under an admission permit (see public-docs-limiter.mjs) and
 * rejects it with a 429 `ApiError` naming `Retry-After` when the limits are reached. A docs page
 * request the included server already admitted runs under the server's permit instead.
 */
export const withPublicDocsAdmission = async <T>(request: ClientIpRequest | undefined, work: () => Promise<T>): Promise<T> => {
  if (isPublicDocsRequestAdmitted(request?.headers)) {
    return work();
  }

  const permit = acquirePublicDocsAdmissionPermit(request);
  if (!permit.allowed) {
    throw new ApiError(429, publicDocsThrottledMessage(permit.retryAfterSeconds), { "Retry-After": String(permit.retryAfterSeconds) });
  }

  try {
    return await work();
  } finally {
    permit.release();
  }
};
