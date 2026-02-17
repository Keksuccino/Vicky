import type { Metadata } from "next";
import { unstable_noStore as noStore } from "next/cache";
import { Manrope, Space_Grotesk } from "next/font/google";
import localFont from "next/font/local";

import { AppHeader } from "@/components/app-header";
import { ThemeProvider } from "@/components/theme-provider";
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
const FALLBACK_SITE_DESCRIPTION = "Docs/wiki frontend with navigation, search, editor, and admin theme management.";

export async function generateMetadata(): Promise<Metadata> {
  noStore();

  let siteTitle = FALLBACK_SITE_TITLE;
  let siteDescription = FALLBACK_SITE_DESCRIPTION;

  try {
    const store = await getStore();
    siteTitle = store.settings.siteTitle || FALLBACK_SITE_TITLE;
    siteDescription = store.settings.siteDescription || FALLBACK_SITE_DESCRIPTION;
  } catch {
    // Keep fallback metadata when settings storage is temporarily unavailable.
  }

  return {
    title: {
      default: siteTitle,
      template: `%s | ${siteTitle}`,
    },
    description: siteDescription,
    icons: {
      icon: [
        { url: "/api/public/icon/16", sizes: "16x16", type: "image/png" },
        { url: "/api/public/icon/32", sizes: "32x32", type: "image/png" },
      ],
      shortcut: [{ url: "/favicon.ico", type: "image/png" }],
      apple: [{ url: "/api/public/icon/180", sizes: "180x180", type: "image/png" }],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-color-mode="light">
      <body className={`${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`}>
        <ThemeProvider>
          <a href="#main-content" className="skip-link">
            Skip to content
          </a>
          <div className="app-shell">
            <AppHeader />
            <div className="app-content">{children}</div>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
