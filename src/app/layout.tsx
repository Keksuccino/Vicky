/* eslint-disable @next/next/no-page-custom-font */
import type { Metadata } from "next";
import { Fira_Code, Manrope, Space_Grotesk } from "next/font/google";

import { AppHeader } from "@/components/app-header";
import { ThemeProvider } from "@/components/theme-provider";

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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-color-mode="light">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:FILL@0..1&display=optional"
        />
      </head>
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
