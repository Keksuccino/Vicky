import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { Manrope, Space_Grotesk } from "next/font/google";
import localFont from "next/font/local";

import { AppHeader } from "@/components/app-header";
import { ThemeProvider } from "@/components/theme-provider";
import { normalizeCustomDomain } from "@/lib/domain-settings";
import { createThemeBootstrapScript, DEFAULT_THEME_CUSTOMIZATION } from "@/lib/theme";
import { getStore } from "@/lib/store";

import "@fontsource/material-symbols-outlined";
import "./globals.css";

const fontDisplay = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

const fontBody = Manrope({
  variable: "--font-body",
  subsets: ["latin"],
});

const fontMono = localFont({
  src: [
    {
      path: "./fonts/google-sans-code-latin.woff2",
      weight: "300 800",
      style: "normal",
    },
  ],
  variable: "--font-mono",
  display: "swap",
});

const FALLBACK_SITE_TITLE = "Vicky Docs";
const FALLBACK_SITE_DESCRIPTION = "Docs/wiki frontend with navigation, search, editor, and admin appearance settings.";
const FALLBACK_ICON_VERSION = "default";
const FALLBACK_FOOTER_TEXT = "Copyright © {{year}} {{owner}}. All rights reserved.";
const FALLBACK_FOOTER_OWNER = "Repository Owner";
const MIN_FOOTER_YEAR = 2026;

const appendVersion = (url: string, version: string): string => `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;

const createIconVersion = (settings: Awaited<ReturnType<typeof getStore>>["settings"]): string => {
  const source = [
    settings.updatedAt,
    settings.docsIcon.png16Url,
    settings.docsIcon.png32Url,
    settings.docsIcon.png180Url,
  ].join("|");

  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
};

const resolveFooterText = (template: string, owner: string): string => {
  const year = String(Math.max(new Date().getFullYear(), MIN_FOOTER_YEAR));
  const resolvedOwner = owner.trim() || FALLBACK_FOOTER_OWNER;

  return template
    .replace(/{{\s*year\s*}}/gi, year)
    .replace(/{{\s*owner\s*}}/gi, resolvedOwner);
};

export async function generateMetadata(): Promise<Metadata> {
  noStore();

  let siteTitle = FALLBACK_SITE_TITLE;
  let siteDescription = FALLBACK_SITE_DESCRIPTION;
  let iconVersion = FALLBACK_ICON_VERSION;
  let metadataBase: URL | undefined;

  try {
    const store = await getStore();
    siteTitle = store.settings.siteTitle || FALLBACK_SITE_TITLE;
    siteDescription = store.settings.siteDescription || FALLBACK_SITE_DESCRIPTION;
    iconVersion = createIconVersion(store.settings);
    const customDomain = normalizeCustomDomain(store.settings.domain.customDomain);
    if (customDomain) {
      metadataBase = new URL(`https://${customDomain}`);
    }
  } catch {
    // Keep fallback metadata when settings storage is temporarily unavailable.
  }

  return {
    title: {
      default: siteTitle,
      template: `%s | ${siteTitle}`,
    },
    ...(metadataBase ? { metadataBase } : {}),
    description: siteDescription,
    icons: {
      icon: [
        { url: appendVersion("/api/public/icon/16", iconVersion), sizes: "16x16", type: "image/png" },
        { url: appendVersion("/api/public/icon/32", iconVersion), sizes: "32x32", type: "image/png" },
      ],
      shortcut: [{ url: appendVersion("/favicon.ico", iconVersion), type: "image/png" }],
      apple: [{ url: appendVersion("/api/public/icon/180", iconVersion), sizes: "180x180", type: "image/png" }],
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  noStore();

  let footerText = resolveFooterText(FALLBACK_FOOTER_TEXT, FALLBACK_FOOTER_OWNER);
  let initialThemeSettings = DEFAULT_THEME_CUSTOMIZATION();

  try {
    const store = await getStore();
    const template = store.settings.footerText.trim() || FALLBACK_FOOTER_TEXT;
    footerText = resolveFooterText(template, store.settings.github.owner);
    initialThemeSettings = store.settings.theme;
  } catch {
    // Keep fallback footer text when settings storage is temporarily unavailable.
  }

  const initialThemeBootstrapScript = createThemeBootstrapScript(initialThemeSettings);

  return (
    <html lang="en" data-color-mode="light" suppressHydrationWarning>
      <head>
        <script id="theme-bootstrap" dangerouslySetInnerHTML={{ __html: initialThemeBootstrapScript }} />
      </head>
      <body className={`${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`}>
        <ThemeProvider initialThemeSettings={initialThemeSettings}>
          <a href="#main-content" className="skip-link">
            Skip to content
          </a>
          <div className="app-shell">
            <AppHeader />
            <div className="app-content">
              {children}
              <footer className="app-footer" aria-label="Site footer">
                <div className="app-footer-card">{footerText}</div>
              </footer>
            </div>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
