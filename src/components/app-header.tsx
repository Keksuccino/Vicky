"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type CSSProperties, useEffect, useState } from "react";

import { fetchPublicSiteSettings, getCurrentUser, logout } from "@/components/api";
import { cn } from "@/components/cn";
import { LanguageSelector } from "@/components/language-selector";
import { MaterialIcon } from "@/components/material-icon";
import { ThemeSwitcher } from "@/components/theme-switcher";
import type { AuthUser, AutoTranslateLanguage } from "@/components/types";

const ADMIN_NAVIGATION = {
  settingsHref: "/admin/settings",
  loginHref: "/admin/login",
  label: "Admin Panel",
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
  label: "Version for AI Agents",
  icon: "text_snippet",
};

const DEFAULT_BRAND_TITLE = "Vicky Docs";

function editorHrefForPathname(pathname: string): string {
  const docsPrefix = "/docs/";

  if (!pathname.startsWith(docsPrefix)) {
    return EDITOR_NAVIGATION.href;
  }

  const docPath = pathname.slice(docsPrefix.length).replace(/\/+$/, "");
  if (!docPath) {
    return EDITOR_NAVIGATION.href;
  }

  const params = new URLSearchParams({ path: `/${docPath}` });
  return `${EDITOR_NAVIGATION.href}?${params.toString()}`;
}

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [brandTitle, setBrandTitle] = useState<string | null>(null);
  const [siteTitleGradient, setSiteTitleGradient] = useState({ from: "", to: "" });
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [hasConfiguredIcon, setHasConfiguredIcon] = useState<boolean | null>(null);
  const [iconLoadFailed, setIconLoadFailed] = useState(false);
  const [autoTranslateEnabled, setAutoTranslateEnabled] = useState(false);
  const [autoTranslateLanguages, setAutoTranslateLanguages] = useState<AutoTranslateLanguage[]>([]);

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
        setAutoTranslateEnabled(settings.autoTranslateEnabled);
        setAutoTranslateLanguages(settings.autoTranslateLanguages);
      } catch {
        if (!active) {
          return;
        }

        setBrandTitle(DEFAULT_BRAND_TITLE);
        setSiteTitleGradient({ from: "", to: "" });
        setHasConfiguredIcon(false);
        setIconLoadFailed(false);
        setAutoTranslateEnabled(false);
        setAutoTranslateLanguages([]);
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

        setCurrentUser(user);
      } catch {
        if (!active) {
          return;
        }

        setCurrentUser(null);
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
  const editorHref = editorHrefForPathname(pathname);
  const adminIsActive = pathname === ADMIN_NAVIGATION.activePrefix || pathname.startsWith(`${ADMIN_NAVIGATION.activePrefix}/`);
  const isAuthenticated = Boolean(currentUser);
  const isAdminAuthenticated = currentUser?.role === "admin";
  const loginHref = ADMIN_NAVIGATION.loginHref;

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
          {brandingReady ? <LanguageSelector enabled={autoTranslateEnabled} languages={autoTranslateLanguages} /> : null}

          <Link
            href={PLAINTEXT_EXPORT_NAVIGATION.href}
            className="admin-icon-link ui-tooltip"
            aria-label={PLAINTEXT_EXPORT_NAVIGATION.label}
            data-ui-tooltip={PLAINTEXT_EXPORT_NAVIGATION.label}
            target="_blank"
            rel="noreferrer"
            prefetch={false}
          >
            <MaterialIcon name={PLAINTEXT_EXPORT_NAVIGATION.icon} />
          </Link>

          {isAuthenticated ? (
            <Link
              href={editorHref}
              className={cn("admin-icon-link ui-tooltip", editorIsActive && "admin-icon-link-active")}
              aria-label={EDITOR_NAVIGATION.label}
              data-ui-tooltip={EDITOR_NAVIGATION.label}
            >
              <MaterialIcon name={EDITOR_NAVIGATION.icon} />
            </Link>
          ) : null}

          {isAdminAuthenticated ? (
            <Link
              href={ADMIN_NAVIGATION.settingsHref}
              className={cn("admin-icon-link ui-tooltip", adminIsActive && "admin-icon-link-active")}
              aria-label={ADMIN_NAVIGATION.label}
              data-ui-tooltip={ADMIN_NAVIGATION.label}
            >
              <MaterialIcon name={ADMIN_NAVIGATION.icon} />
            </Link>
          ) : null}

          {isAuthenticated ? (
            <button
              type="button"
              className="admin-icon-link ui-tooltip"
              aria-label="Logout"
              data-ui-tooltip="Logout"
              disabled={isLoggingOut}
              onClick={async () => {
                setIsLoggingOut(true);
                try {
                  await logout();
                  setCurrentUser(null);
                  if (pathname === "/admin" || pathname.startsWith("/admin/") || pathname === "/editor" || pathname.startsWith("/editor/")) {
                    router.push(`${ADMIN_NAVIGATION.loginHref}?next=${encodeURIComponent(pathname)}`);
                  } else {
                    router.refresh();
                  }
                } finally {
                  setIsLoggingOut(false);
                }
              }}
            >
              <MaterialIcon name={isLoggingOut ? "hourglass_top" : "logout"} />
            </button>
          ) : (
            <Link href={loginHref} className="admin-icon-link ui-tooltip" aria-label="Login" data-ui-tooltip="Login">
              <MaterialIcon name="login" />
            </Link>
          )}
          <ThemeSwitcher />
        </div>
      </div>
    </header>
  );
}
