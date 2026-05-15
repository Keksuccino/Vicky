import { ApiError } from "@/lib/http";

export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TIMEOUT_CHUNK_MS = 2_147_483_647;

export type OpenRouterMessage =
  | {
      role: "system" | "assistant" | "user";
      content: string;
    }
  | {
      role: "user";
      content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    };

const safeJsonParse = (input: string): unknown => {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
};

export const extractOpenRouterErrorMessage = (payload: unknown, fallback: string): string => {
  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }

  if (typeof payload !== "object" || payload === null) {
    return fallback;
  }

  const record = payload as Record<string, unknown>;
  const directMessage = record.message;
  if (typeof directMessage === "string" && directMessage.trim()) {
    return directMessage;
  }

  const errorRecord = typeof record.error === "object" && record.error !== null ? (record.error as Record<string, unknown>) : null;
  const nestedMessage = errorRecord?.message;
  if (typeof nestedMessage === "string" && nestedMessage.trim()) {
    return nestedMessage;
  }

  return fallback;
};

export const extractOpenRouterAssistantText = (content: unknown): string => {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (typeof part !== "object" || part === null) {
          return "";
        }

        const source = part as Record<string, unknown>;
        if (typeof source.text === "string") {
          return source.text;
        }

        return "";
      })
      .join("\n\n")
      .trim();
  }

  if (typeof content === "object" && content !== null) {
    const source = content as Record<string, unknown>;
    if (typeof source.text === "string") {
      return source.text.trim();
    }
  }

  return "";
};

const formatRequestFailure = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [`${error.name || "Error"}: ${error.message || "No error message provided."}`];
  const cause = (error as Error & { cause?: unknown }).cause;

  if (cause !== undefined) {
    parts.push(`Cause: ${formatRequestFailure(cause)}`);
  }

  return parts.join(" ");
};

const formatDuration = (ms: number): string => {
  const seconds = Math.max(1, Math.round(ms / 1_000));

  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

const normalizeRequestTimeoutMs = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value);
};

const createTimeoutSignal = (
  timeoutMs: number | null,
): { signal?: AbortSignal; timedOut: () => boolean; cleanup: () => void } => {
  if (timeoutMs === null) {
    return {
      timedOut: () => false,
      cleanup: () => undefined,
    };
  }

  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timeoutReached = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      timeoutReached = true;
      controller.abort();
      return;
    }

    timer = setTimeout(schedule, Math.min(remainingMs, MAX_TIMEOUT_CHUNK_MS));
  };

  schedule();

  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup: () => {
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
};

export const requestOpenRouterChatCompletion = async ({
  apiKey,
  messages,
  model,
  origin,
  siteTitle,
  timeoutMs,
}: {
  apiKey: string;
  messages: OpenRouterMessage[];
  model: string;
  origin: string;
  siteTitle: string;
  timeoutMs?: number;
}): Promise<string> => {
  let response: Response;
  let rawText = "";
  const normalizedTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  const timeout = createTimeoutSignal(normalizedTimeoutMs);

  try {
    response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": origin,
        "X-Title": siteTitle || "Vicky Docs",
      },
      body: JSON.stringify({
        model: model.trim(),
        messages,
      }),
      cache: "no-store",
      signal: timeout.signal,
    });
    rawText = await response.text();
  } catch (error: unknown) {
    if (timeout.timedOut() && normalizedTimeoutMs !== null) {
      throw new ApiError(504, `OpenRouter request timed out after ${formatDuration(normalizedTimeoutMs)}.`);
    }

    throw new ApiError(502, `OpenRouter request could not be completed. ${formatRequestFailure(error)}`);
  } finally {
    timeout.cleanup();
  }

  const parsed = rawText ? safeJsonParse(rawText) : null;

  if (!response.ok) {
    throw new ApiError(response.status, extractOpenRouterErrorMessage(parsed, "OpenRouter request failed."));
  }

  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = choices[0];
  const message =
    typeof firstChoice === "object" && firstChoice !== null
      ? ((firstChoice as Record<string, unknown>).message as Record<string, unknown> | undefined)
      : undefined;
  const assistantText = extractOpenRouterAssistantText(message?.content);

  if (!assistantText) {
    throw new ApiError(502, "OpenRouter returned an empty response.");
  }

  return assistantText;
};
