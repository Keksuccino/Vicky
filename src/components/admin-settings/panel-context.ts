import { createContext, useContext, type Context } from "react";

import type { LocalizationStatus } from "@/components/admin-settings/localization-status";
import type { MarkdownCacheStatus } from "@/components/admin-settings/markdown-cache";
import type { PerformanceStats } from "@/components/admin-settings/performance-stats";
import type { ClearSecretTarget, SettingsStore } from "@/components/admin-settings/settings-store";
import type { SslStatus } from "@/components/admin-settings/ssl-status";
import type { VisitorStats } from "@/components/admin-settings/visitor-stats";
import type { ModeratorAccount } from "@/components/types";

/**
 * What the cards use to act across the panel. Every member keeps its identity for the panel's
 * lifetime, so reading this context never re-renders a card.
 */
export type AdminPanelServices = {
  lifetimeSignal: () => AbortSignal;
  settingsStore: SettingsStore;
  /** Saves the draft now; actions that read saved settings on the server call it first. */
  persistLatestSettings: () => Promise<void>;
  clearSavedSecret: (target: ClearSecretTarget) => Promise<void>;
  refreshTranslationOverview: () => Promise<void>;
  /** Loads the Markdown cache status again, but only once the admin asked for it. */
  refreshRequestedMarkdownCacheStatus: () => void;
};

export type PanelLoadState = {
  loading: boolean;
  loadError: string | null;
  /** The moderator list as the panel loaded it. */
  initialModerators: ModeratorAccount[];
};

export const AdminPanelServicesContext = createContext<AdminPanelServices | null>(null);
export const PanelLoadContext = createContext<PanelLoadState | null>(null);
export const SslStatusContext = createContext<SslStatus | null>(null);
export const PerformanceStatsContext = createContext<PerformanceStats | null>(null);
export const VisitorStatsContext = createContext<VisitorStats | null>(null);
export const MarkdownCacheContext = createContext<MarkdownCacheStatus | null>(null);
export const LocalizationContext = createContext<LocalizationStatus | null>(null);

const usePanelContext = <T>(context: Context<T | null>): T => {
  const value = useContext(context);
  if (!value) {
    throw new Error("Admin settings cards must be rendered inside AdminPanelProvider.");
  }

  return value;
};

export const useAdminPanel = (): AdminPanelServices => usePanelContext(AdminPanelServicesContext);
export const usePanelLoad = (): PanelLoadState => usePanelContext(PanelLoadContext);
export const useSslStatusContext = (): SslStatus => usePanelContext(SslStatusContext);
export const usePerformanceStatsContext = (): PerformanceStats => usePanelContext(PerformanceStatsContext);
export const useVisitorStatsContext = (): VisitorStats => usePanelContext(VisitorStatsContext);
export const useMarkdownCacheContext = (): MarkdownCacheStatus => usePanelContext(MarkdownCacheContext);
export const useLocalizationContext = (): LocalizationStatus => usePanelContext(LocalizationContext);
