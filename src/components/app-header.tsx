"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type CSSProperties, useEffect, useState } from "react";

import { fetchPublicSiteSettings, getCurrentUser } from "@/components/api";
import { cn } from "@/components/cn";
import { MaterialIcon } from "@/components/material-icon";
import { ThemeSwitcher } from "@/components/theme-switcher";

const ADMIN_NAVIGATION = {
  settingsHref: "/admin/settings",
  loginHref: "/admin/login",
  label: "Admin",
  icon: "admin_panel_settings",
  activePrefix: "/admin",
};

const EDITOR_NAVIGATION = {
  href: "/editor",
  label: "Editor",
  icon: "edit_square",
  activePrefix: "/editor",
};

const PLAINTEXT_EXPORT_NAVIGATION = {
  href: "/docs.txt",
  label: "AI plaintext docs",
  icon: "text_snippet",
};

const DEFAULT_BRAND_TITLE = "Vicky Docs";

export function AppHeader() {
  const pathname = usePathname();
  const [brandTitle, setBrandTitle] = useState<string | null>(null);
  const [siteTitleGradient, setSiteTitleGradient] = useState({ from: "", to: "" });
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [hasConfiguredIcon, setHasConfiguredIcon] = useState<boolean | null>(null);
  const [iconLoadFailed, setIconLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;

    const run = async () => {
      try {
        const settings = await fetchPublicSiteSettings();
        if (!active) {
          return;
        }

        setBrandTitle(settings.siteTitle.trim() || DEFAULT_BRAND_TITLE);
        setSiteTitleGradient({
          from: settings.siteTitleGradientFrom.trim(),
          to: settings.siteTitleGradientTo.trim(),
        });
        setHasConfiguredIcon(Boolean(settings.docsIconPng180Url.trim()));
        setIconLoadFailed(false);
      } catch {
        if (!active) {
          return;
        }

        setBrandTitle(DEFAULT_BRAND_TITLE);
        setSiteTitleGradient({ from: "", to: "" });
        setHasConfiguredIcon(false);
        setIconLoadFailed(false);
      }
    };

    void run();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    const run = async () => {
      try {
        const user = await getCurrentUser();
        if (!active) {
          return;
        }

        setIsAdminAuthenticated(Boolean(user));
      } catch {
        if (!active) {
          return;
        }

        setIsAdminAuthenticated(false);
      }
    };

    void run();

    return () => {
      active = false;
    };
  }, [pathname]);

  const brandingReady = brandTitle !== null && hasConfiguredIcon !== null;
  const resolvedBrandTitle = brandTitle ?? DEFAULT_BRAND_TITLE;
  const hasSiteTitleGradient = Boolean(siteTitleGradient.from && siteTitleGradient.to);
  const brandTitleStyle: CSSProperties | undefined = hasSiteTitleGradient
    ? ({
        "--brand-title-gradient-from": siteTitleGradient.from,
        "--brand-title-gradient-to": siteTitleGradient.to,
      } as CSSProperties)
    : undefined;
  const useCustomIcon = brandingReady && hasConfiguredIcon && !iconLoadFailed;
  const showFallbackIcon = brandingReady && !useCustomIcon;
  const editorIsActive =
    pathname === EDITOR_NAVIGATION.activePrefix ||
    pathname.startsWith(`${EDITOR_NAVIGATION.activePrefix}/`) ||
    pathname === EDITOR_NAVIGATION.href ||
    pathname.startsWith(`${EDITOR_NAVIGATION.href}/`);
  const adminIsActive = pathname === ADMIN_NAVIGATION.activePrefix || pathname.startsWith(`${ADMIN_NAVIGATION.activePrefix}/`);
  const adminHref = isAdminAuthenticated
    ? ADMIN_NAVIGATION.settingsHref
    : `${ADMIN_NAVIGATION.loginHref}?next=${encodeURIComponent(ADMIN_NAVIGATION.settingsHref)}`;

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/" className="app-brand" aria-label={brandingReady ? `${resolvedBrandTitle} home` : "Documentation home"}>
          {useCustomIcon ? (
            <span className="brand-mark brand-mark-icon" aria-hidden="true">
              <Image
                src="/api/public/icon/180"
                alt=""
                width={32}
                height={32}
                className="brand-mark-image"
                unoptimized
                onError={() => setIconLoadFailed(true)}
              />
            </span>
          ) : showFallbackIcon ? (
            <span className="brand-mark">V</span>
          ) : (
            <span className="brand-mark-placeholder" aria-hidden="true" />
          )}
          {brandingReady ? (
            <span className={cn("brand-text", hasSiteTitleGradient && "brand-text-gradient")} style={brandTitleStyle}>
              {resolvedBrandTitle}
            </span>
          ) : (
            <span className="brand-text-placeholder" aria-hidden="true" />
          )}
        </Link>

        <div className="app-header-actions">
          {isAdminAuthenticated ? (
            <Link
              href={EDITOR_NAVIGATION.href}
              className={cn("admin-icon-link", editorIsActive && "admin-icon-link-active")}
              aria-label={EDITOR_NAVIGATION.label}
              title={EDITOR_NAVIGATION.label}
            >
              <MaterialIcon name={EDITOR_NAVIGATION.icon} />
            </Link>
          ) : null}

          <Link
            href={adminHref}
            className={cn("admin-icon-link", adminIsActive && "admin-icon-link-active")}
            aria-label={ADMIN_NAVIGATION.label}
            title={ADMIN_NAVIGATION.label}
          >
            <MaterialIcon name={ADMIN_NAVIGATION.icon} />
          </Link>

          <Link
            href={PLAINTEXT_EXPORT_NAVIGATION.href}
            className="admin-icon-link"
            aria-label={PLAINTEXT_EXPORT_NAVIGATION.label}
            title={PLAINTEXT_EXPORT_NAVIGATION.label}
            target="_blank"
            rel="noreferrer"
            prefetch={false}
          >
            <MaterialIcon name={PLAINTEXT_EXPORT_NAVIGATION.icon} />
          </Link>
          <ThemeSwitcher />
        </div>
      </div>
    </header>
  );
}
