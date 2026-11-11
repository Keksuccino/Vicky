"use client";

import { AiChatSettingsCard } from "@/components/admin-settings/ai-chat-settings-card";
import { DomainSettingsCard } from "@/components/admin-settings/domain-settings-card";
import { LocalizationCard } from "@/components/admin-settings/localization-card";
import { MarkdownCacheCard } from "@/components/admin-settings/markdown-cache-card";
import { ModeratorsCard } from "@/components/admin-settings/moderators-card";
import { OpenRouterSettingsCard } from "@/components/admin-settings/openrouter-settings-card";
import { usePanelLoad } from "@/components/admin-settings/panel-context";
import { AdminPanelProvider } from "@/components/admin-settings/panel-provider";
import { PerformanceStatsCard } from "@/components/admin-settings/performance-stats-card";
import { RepositorySettingsCard } from "@/components/admin-settings/repository-settings-card";
import { useSettingsSelector, type SettingsState } from "@/components/admin-settings/settings-store";
import { SiteSettingsCard } from "@/components/admin-settings/site-settings-card";
import { ThemeSettingsCard } from "@/components/admin-settings/theme-settings-card";
import { VisitorStatsCard } from "@/components/admin-settings/visitor-stats-card";
import { ErrorState, LoadingState } from "@/components/states";

/** The admin panel: the provider owns its state, and each card reads only what it shows. */
export function AdminSettingsPanel() {
  return (
    <AdminPanelProvider>
      <AdminSettingsContent />
    </AdminPanelProvider>
  );
}

function AdminSettingsContent() {
  const { loadError, loading } = usePanelLoad();

  if (loading) {
    return <LoadingState label="Loading admin settings..." />;
  }

  if (loadError) {
    return (
      <ErrorState
        title="Unable to load admin settings"
        message={loadError}
        actionLabel="Retry"
        onAction={() => window.location.reload()}
      />
    );
  }

  return (
    <section className="admin-page">
      <SaveErrorMessage />

      <div className="panel-grid">
        <div className="panel-stack-left">
          <PerformanceStatsCard />
          <RepositorySettingsCard />
          <MarkdownCacheCard />
          <ModeratorsCard />
          <SiteSettingsCard />
          <DomainSettingsCard />
          <AiChatSettingsCard />
        </div>

        <div className="panel-stack-right">
          <VisitorStatsCard />
          <ThemeSettingsCard />
          <OpenRouterSettingsCard />
          <LocalizationCard />
        </div>
      </div>
    </section>
  );
}

const selectSaveError = (state: SettingsState): string | null => state.saveError;

function SaveErrorMessage() {
  const saveError = useSettingsSelector(selectSaveError);
  return saveError ? <p className="error-text">{saveError}</p> : null;
}
