import { useCallback, useMemo, useState } from "react";

import { fetchAdminDomainSslStatus, formatApiError } from "@/components/api";
import type { DomainSslRuntimeStatus } from "@/components/types";

export type SslStatus = {
  error: string | null;
  loading: boolean;
  status: DomainSslRuntimeStatus | null;
};

/** The certificate runtime status of the domain card: loaded with the panel, and again after a save changed the domain settings. */
export function useSslStatus(lifetimeSignal: () => AbortSignal) {
  const [status, setStatus] = useState<DomainSslRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshSslStatus = useCallback(async () => {
    const signal = lifetimeSignal();
    setLoading(true);
    setError(null);

    try {
      const nextStatus = await fetchAdminDomainSslStatus({ signal });
      if (!signal.aborted) {
        setStatus(nextStatus);
      }
    } catch (requestError) {
      if (!signal.aborted) {
        setStatus(null);
        setError(formatApiError(requestError));
      }
    } finally {
      if (!signal.aborted) {
        setLoading(false);
      }
    }
  }, [lifetimeSignal]);

  const sslStatus = useMemo<SslStatus>(() => ({ error, loading, status }), [error, loading, status]);

  return { refreshSslStatus, sslStatus };
}
