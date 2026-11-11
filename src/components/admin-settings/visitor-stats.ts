import { useCallback, useEffect, useMemo, useState } from "react";

import { useNewestRequest } from "@/components/admin-settings/request-lifetime";
import { fetchAdminVisitorStats } from "@/components/api";
import type { VisitorAnalyticsStatus, VisitorStatsSummary } from "@/components/types";

/** How often the card asks again while earlier visits are still being added to the numbers. */
const VISITOR_STATS_CATCH_UP_POLL_MS = 2_000;
/** How soon the card asks again when the server was still computing the numbers. */
const VISITOR_STATS_PENDING_POLL_MS = 1_000;

export type VisitorStatsRefreshOptions = { refresh?: boolean; silent?: boolean };

export type VisitorStats = {
  error: string | null;
  loading: boolean;
  refreshVisitorStats: (options?: VisitorStatsRefreshOptions) => Promise<void>;
  stats: VisitorStatsSummary | null;
  status: VisitorAnalyticsStatus | null;
};

/** Visit numbers: loaded with the panel, and polled only while the server catches up on visits or computes them. */
export function useVisitorStats(lifetimeSignal: () => AbortSignal): VisitorStats {
  const [stats, setStats] = useState<VisitorStatsSummary | null>(null);
  const [status, setStatus] = useState<VisitorAnalyticsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const runRequest = useNewestRequest(lifetimeSignal);

  /**
   * Loads the analytics numbers. Only the newest request may update the card, so a slow older
   * response never replaces newer numbers. Background polls (`silent`) leave the refresh button
   * alone, and numbers already shown stay until newer ones arrive.
   */
  const refreshVisitorStats = useCallback(async ({ refresh = false, silent = false }: VisitorStatsRefreshOptions = {}) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }

    const result = await runRequest((signal) => fetchAdminVisitorStats({ refresh, signal }));
    if (!result) {
      return;
    }

    if (result.value) {
      if (result.value.stats) {
        setStats(result.value.stats);
      }
      setStatus(result.value.status);
    }
    setError(result.error);
    setLoading(false);
  }, [runRequest]);

  useEffect(() => {
    const catchingUp = Boolean(status?.catchingUp);
    if (!catchingUp && !status?.refreshing) {
      return;
    }

    const timer = window.setTimeout(() => {
      void refreshVisitorStats({ silent: true });
    }, catchingUp ? VISITOR_STATS_CATCH_UP_POLL_MS : VISITOR_STATS_PENDING_POLL_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [refreshVisitorStats, status]);

  return useMemo(() => ({ error, loading, refreshVisitorStats, stats, status }), [error, loading, refreshVisitorStats, stats, status]);
}
