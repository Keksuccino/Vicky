import type { AutoTranslateLanguage } from "@/lib/types";

type LogValue = boolean | number | string | null | undefined;

type LogContext = Record<string, LogValue>;

const formatLogValue = (value: LogValue): string => {
  if (value === undefined) {
    return "";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return String(value);
};

const formatLogContext = (context: LogContext): string => {
  const fields = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`);

  return fields.length > 0 ? ` ${fields.join(" ")}` : "";
};

export const formatAutoTranslateLanguageForLog = (language: Pick<AutoTranslateLanguage, "code" | "name">): string => {
  const name = language.name.trim() || "Unknown";
  const code = language.code.trim() || "unknown";
  return `${name} (${code})`;
};

export const getAutoTranslateErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const logAutoTranslateInfo = (message: string, context: LogContext = {}): void => {
  console.info(`[auto-translate] ${message}${formatLogContext(context)}`);
};
