"use client";

import { useMemo, useState, type ReactNode } from "react";

import { useLocalizationStatus } from "@/components/admin-settings/localization-status";
import { useMarkdownCacheStatus } from "@/components/admin-settings/markdown-cache";
import {
  AdminPanelServicesContext,
  LocalizationContext,
  MarkdownCacheContext,
  PanelLoadContext,
  PerformanceStatsContext,
  SslStatusContext,
  VisitorStatsContext,
  type AdminPanelServices,
  type PanelLoadState,
} from "@/components/admin-settings/panel-context";
import { useInitialPanelLoad } from "@/components/admin-settings/panel-load";
import { usePerformanceStats } from "@/components/admin-settings/performance-stats";
import { usePanelLifetimeSignal } from "@/components/admin-settings/request-lifetime";
import { useSettingsAutoSave } from "@/components/admin-settings/settings-auto-save";
import { createSettingsStore } from "@/components/admin-settings/settings-store";
import { useSslStatus } from "@/components/admin-settings/ssl-status";
import { useVisitorStats } from "@/components/admin-settings/visitor-stats";
import { useTheme } from "@/components/theme-provider";
import type { ModeratorAccount } from "@/components/types";

/**
 * Owns the panel's state for its whole lifetime and wires the cards together: what loads when
 * the panel opens, and which change refreshes which card. Each card reads its own context, so a
 * change re-renders only the cards that show it; `children` itself never re-renders from here.
 */
export function AdminPanelProvider({ children }: { children: ReactNode }) {
  const { setThemeSettings } = useTheme();
  const lifetimeSignal = usePanelLifetimeSignal();
  const [settingsStore] = useState(createSettingsStore);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialModerators, setInitialModerators] = useState<ModeratorAccount[]>([]);
  const panelReady = !loading && !loadError;

  const { refreshSslStatus, sslStatus } = useSslStatus(lifetimeSignal);
  const performanceStats = usePerformanceStats(lifetimeSignal, panelReady);
  const visitorStats = useVisitorStats(lifetimeSignal);
  const { markdownCacheStatus, refreshMarkdownCacheWarmJob, refreshRequestedMarkdownCacheStatus } = useMarkdownCacheStatus(lifetimeSignal, panelReady);
  // A finished translation job changes the translated pages, so the Markdown cache status follows.
  const { localizationStatus, refreshOverviewAfterSave, refreshTranslationJobStatus, refreshTranslationOverview } = useLocalizationStatus({
    lifetimeSignal,
    onJobFinished: refreshRequestedMarkdownCacheStatus,
    panelReady,
    settingsStore,
  });
  const { applyLoadedSettings, clearSavedSecret, isAutoSaveReady, persistLatestSettings } = useSettingsAutoSave({
    onSaved: refreshOverviewAfterSave,
    refreshSslStatus,
    setThemeSettings,
    settingsStore,
  });

  useInitialPanelLoad({
    applyLoadedSettings,
    isAutoSaveReady,
    lifetimeSignal,
    loadError,
    loading,
    refreshAfterLoad: {
      refreshSslStatus,
      refreshPerformanceStats: performanceStats.refreshPerformanceStats,
      refreshVisitorStats: visitorStats.refreshVisitorStats,
      refreshMarkdownCacheWarmJob,
    },
    refreshTranslationJobStatus,
    refreshTranslationOverview,
    setInitialModerators,
    setLoadError,
    setLoading,
  });

  const services = useMemo<AdminPanelServices>(
    () => ({ clearSavedSecret, lifetimeSignal, persistLatestSettings, refreshRequestedMarkdownCacheStatus, refreshTranslationOverview, settingsStore }),
    [clearSavedSecret, lifetimeSignal, persistLatestSettings, refreshRequestedMarkdownCacheStatus, refreshTranslationOverview, settingsStore],
  );
  const panelLoad = useMemo<PanelLoadState>(() => ({ initialModerators, loadError, loading }), [initialModerators, loadError, loading]);

  return (
    <AdminPanelServicesContext.Provider value={services}>
      <PanelLoadContext.Provider value={panelLoad}>
        <SslStatusContext.Provider value={sslStatus}>
          <PerformanceStatsContext.Provider value={performanceStats}>
            <VisitorStatsContext.Provider value={visitorStats}>
              <MarkdownCacheContext.Provider value={markdownCacheStatus}>
                <LocalizationContext.Provider value={localizationStatus}>{children}</LocalizationContext.Provider>
              </MarkdownCacheContext.Provider>
            </VisitorStatsContext.Provider>
          </PerformanceStatsContext.Provider>
        </SslStatusContext.Provider>
      </PanelLoadContext.Provider>
    </AdminPanelServicesContext.Provider>
  );
}
