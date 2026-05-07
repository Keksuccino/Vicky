"use client";

import dynamic from "next/dynamic";

const AppHeader = dynamic(() => import("@/components/app-header").then((module) => module.AppHeader), {
  ssr: false,
  loading: () => (
    <header className="app-header" aria-hidden="true">
      <div className="app-header-inner">
        <span className="app-brand">
          <span className="brand-mark-placeholder" />
          <span className="brand-text-placeholder" />
        </span>
      </div>
    </header>
  ),
});

export function LazyAppHeader() {
  return <AppHeader />;
}
