"use client";

import { createContext, useContext, type ReactNode } from "react";

import { ErrorState } from "@/components/states";

const DocsPageErrorMessageContext = createContext<string | undefined>(undefined);

export function DocsPageErrorMessageProvider({ children, message }: { children: ReactNode; message?: string }) {
  return <DocsPageErrorMessageContext.Provider value={message}>{children}</DocsPageErrorMessageContext.Provider>;
}

/**
 * Error card for a docs page that could not be served. The docs route's not-found and error
 * boundaries render it without props (and production builds redact thrown messages), so the
 * docs layout provides the public message through context.
 */
export function DocsPageErrorState() {
  const message = useContext(DocsPageErrorMessageContext);
  return <ErrorState title="Unable to load page" message={message} />;
}
