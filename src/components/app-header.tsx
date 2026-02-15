"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/cn";
import { MaterialIcon } from "@/components/material-icon";
import { ThemeSwitcher } from "@/components/theme-switcher";

const navigation = [
  { href: "/docs", label: "Docs", icon: "menu_book" },
  { href: "/editor", label: "Editor", icon: "edit_square" },
  { href: "/admin/settings", label: "Admin", icon: "admin_panel_settings" },
];

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link href="/" className="app-brand" aria-label="Vicky home">
          <span className="brand-mark">V</span>
          <span className="brand-text">Vicky Docs</span>
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
