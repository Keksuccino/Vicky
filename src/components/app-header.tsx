"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { fetchPublicSiteSettings } from "@/components/api";
import { cn } from "@/components/cn";
import { MaterialIcon } from "@/components/material-icon";
import { ThemeSwitcher } from "@/components/theme-switcher";

const navigation = [
  { href: "/docs", label: "Docs", icon: "menu_book" },
  { href: "/editor", label: "Editor", icon: "edit_square" },
  { href: "/admin/settings", label: "Admin", icon: "admin_panel_settings" },
];

const DEFAULT_BRAND_TITLE = "Vicky Docs";

export function AppHeader() {
  const pathname = usePathname();
  const [brandTitle, setBrandTitle] = useState(DEFAULT_BRAND_TITLE);
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

  const useCustomIcon = hasConfiguredIcon && !iconLoadFailed;

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
          {navigation.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} className={cn("nav-link", isActive && "nav-link-active")}>
                <MaterialIcon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <ThemeSwitcher />
      </div>
    </header>
  );
}
