import type { Metadata } from "next";
import { Fira_Code, Manrope, Space_Grotesk } from "next/font/google";

import { AppHeader } from "@/components/app-header";
import { ThemeProvider } from "@/components/theme-provider";

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

const fontMono = Fira_Code({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Vicky Docs",
    template: "%s | Vicky Docs",
  },
  description: "Docs/wiki frontend with navigation, search, editor, and admin theme management.",
  icons: {
    icon: [
      { url: "/api/public/icon/16", sizes: "16x16", type: "image/png" },
      { url: "/api/public/icon/32", sizes: "32x32", type: "image/png" },
    ],
    shortcut: [{ url: "/api/public/icon/32", type: "image/png" }],
    apple: [{ url: "/api/public/icon/180", sizes: "180x180", type: "image/png" }],
  },
};

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
