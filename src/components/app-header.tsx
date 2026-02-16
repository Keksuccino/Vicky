"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { fetchPublicSiteSettings, getCurrentUser } from "@/components/api";
import { cn } from "@/components/cn";
import { MaterialIcon } from "@/components/material-icon";
import { ThemeSwitcher } from "@/components/theme-switcher";

type NavigationItem = {
  href: string;
  label: string;
  icon: string;
  activePrefix: string;
};

const ADMIN_NAVIGATION = {
  settingsHref: "/admin/settings",
  loginHref: "/admin/login",
  label: "Admin",
  icon: "admin_panel_settings",
  activePrefix: "/admin",
};

const EDITOR_NAVIGATION: NavigationItem = {
  href: "/editor",
  label: "Editor",
  icon: "edit_square",
  activePrefix: "/editor",
};

const DEFAULT_BRAND_TITLE = "Vicky Docs";

export function AppHeader() {
  const pathname = usePathname();
  const [brandTitle, setBrandTitle] = useState(DEFAULT_BRAND_TITLE);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [hasConfiguredIcon, setHasConfiguredIcon] = useState(false);
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
        setHasConfiguredIcon(Boolean(settings.docsIconPng180Url.trim()));
        setIconLoadFailed(false);
      } catch {
        if (!active) {
          return;
        }

        setBrandTitle(DEFAULT_BRAND_TITLE);
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

  const useCustomIcon = hasConfiguredIcon && !iconLoadFailed;
  const navItems: NavigationItem[] = isAdminAuthenticated ? [EDITOR_NAVIGATION] : [];
  const adminIsActive = pathname === ADMIN_NAVIGATION.activePrefix || pathname.startsWith(`${ADMIN_NAVIGATION.activePrefix}/`);
  const adminHref = isAdminAuthenticated
    ? ADMIN_NAVIGATION.settingsHref
    : `${ADMIN_NAVIGATION.loginHref}?next=${encodeURIComponent(ADMIN_NAVIGATION.settingsHref)}`;

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/" className="app-brand" aria-label={`${brandTitle} home`}>
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
          ) : (
            <span className="brand-mark">V</span>
          )}
          <span className="brand-text">{brandTitle}</span>
        </Link>

        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map((item) => {
            const isActive =
              pathname === item.activePrefix ||
              pathname.startsWith(`${item.activePrefix}/`) ||
              pathname === item.href ||
              pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.label} href={item.href} className={cn("nav-link", isActive && "nav-link-active")}>
                <MaterialIcon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="app-header-actions">
          <Link
            href={adminHref}
            className={cn("admin-icon-link", adminIsActive && "admin-icon-link-active")}
            aria-label={ADMIN_NAVIGATION.label}
            title={ADMIN_NAVIGATION.label}
          >
            <MaterialIcon name={ADMIN_NAVIGATION.icon} />
          </Link>
          <ThemeSwitcher />
        </div>
      </div>
    </header>
  );
}
