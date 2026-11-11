import { useCallback, useEffect, useMemo, useState } from "react";

import { useNewestRequest } from "@/components/admin-settings/request-lifetime";
import { fetchAdminPerformanceStats } from "@/components/api";
import type { PerformanceStatsSnapshot } from "@/components/types";

const PERFORMANCE_REFRESH_INTERVAL_MS = 60_000;

export type PerformanceStats = {
  error: string | null;
  loading: boolean;
  refreshPerformanceStats: () => Promise<void>;
  stats: PerformanceStatsSnapshot | null;
};

/** Server resource usage: loaded with the panel, then again every minute while the panel shows. */
export function usePerformanceStats(lifetimeSignal: () => AbortSignal, panelReady: boolean): PerformanceStats {
  const [stats, setStats] = useState<PerformanceStatsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const runRequest = useNewestRequest(lifetimeSignal);

  const refreshPerformanceStats = useCallback(async () => {
    setLoading(true);
    setError(null);

    const result = await runRequest((signal) => fetchAdminPerformanceStats({ signal }));
    if (!result) {
      return;
    }

    setStats(result.value);
    setError(result.error);
    setLoading(false);
  }, [runRequest]);

  useEffect(() => {
    if (!panelReady) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshPerformanceStats();
    }, PERFORMANCE_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [panelReady, refreshPerformanceStats]);

  return useMemo(() => ({ error, loading, refreshPerformanceStats, stats }), [error, loading, refreshPerformanceStats, stats]);
}
