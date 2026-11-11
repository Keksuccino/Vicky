import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { fetchAdminModerators, fetchAdminSettings, formatApiError, getCurrentUser } from "@/components/api";
import type { AdminSettings, ModeratorAccount } from "@/components/types";

/** How long after the panel opened the localization status is requested. */
const TRANSLATION_STATUS_INITIAL_DELAY_MS = 650;

type PanelLoadOptions = {
  applyLoadedSettings: (settings: AdminSettings) => void;
  isAutoSaveReady: () => boolean;
  lifetimeSignal: () => AbortSignal;
  loadError: string | null;
  loading: boolean;
  /** Requested together once the settings are shown, in this order. */
  refreshAfterLoad: {
    refreshSslStatus: () => Promise<void>;
    refreshPerformanceStats: () => Promise<void>;
    refreshVisitorStats: () => Promise<void>;
    /** A warm job keeps running while the admin is away; its progress is shown again. */
    refreshMarkdownCacheWarmJob: () => Promise<void>;
  };
  refreshTranslationJobStatus: () => Promise<void>;
  refreshTranslationOverview: () => Promise<void>;
  setInitialModerators: (moderators: ModeratorAccount[]) => void;
  setLoadError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
};

/**
 * What the panel requests when it opens: the signed-in user, then the settings and moderators,
 * then the SSL status, performance, visitor stats and the warm job, and the localization status
 * once the page is visible a moment later. The Markdown cache status loads only on request.
 */
export function useInitialPanelLoad({
  applyLoadedSettings,
  isAutoSaveReady,
  lifetimeSignal,
  loadError,
  loading,
  refreshAfterLoad,
  refreshTranslationJobStatus,
  refreshTranslationOverview,
  setInitialModerators,
  setLoadError,
  setLoading,
}: PanelLoadOptions): void {
  const router = useRouter();
  const { refreshMarkdownCacheWarmJob, refreshPerformanceStats, refreshSslStatus, refreshVisitorStats } = refreshAfterLoad;

  useEffect(() => {
    if (loading || loadError || !isAutoSaveReady()) {
      return;
    }

    let requested = false;
    const refreshOnceVisible = () => {
      if (requested || document.visibilityState === "hidden") {
        return;
      }

      requested = true;
      void refreshTranslationJobStatus();
      void refreshTranslationOverview();
    };

    const timeoutId = window.setTimeout(refreshOnceVisible, TRANSLATION_STATUS_INITIAL_DELAY_MS);
    document.addEventListener("visibilitychange", refreshOnceVisible);

    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", refreshOnceVisible);
    };
  }, [isAutoSaveReady, loadError, loading, refreshTranslationJobStatus, refreshTranslationOverview]);

  useEffect(() => {
    let isActive = true;
    const signal = lifetimeSignal();
    const isCurrent = (): boolean => isActive && !signal.aborted;

    const run = async () => {
      setLoading(true);
      setLoadError(null);

      try {
        const currentUser = await getCurrentUser({ signal });
        if (!isCurrent()) {
          return;
        }
        if (!currentUser) {
          router.replace("/admin/login");
          return;
        }

        if (currentUser.role !== "admin") {
          router.replace("/editor");
          return;
        }

        const [loadedSettings, loadedModerators] = await Promise.all([
          fetchAdminSettings({ signal }),
          fetchAdminModerators({ signal }),
        ]);
        if (!isCurrent()) {
          return;
        }

        applyLoadedSettings(loadedSettings);
        setInitialModerators(loadedModerators);
        void refreshSslStatus();
        void refreshPerformanceStats();
        void refreshVisitorStats();
        void refreshMarkdownCacheWarmJob();
      } catch (error) {
        if (isCurrent()) {
          setLoadError(formatApiError(error));
        }
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      isActive = false;
    };
  }, [applyLoadedSettings, lifetimeSignal, refreshMarkdownCacheWarmJob, refreshPerformanceStats, refreshSslStatus, refreshVisitorStats, router, setInitialModerators, setLoadError, setLoading]);
}
