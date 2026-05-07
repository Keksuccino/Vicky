import { ApiError } from "@/lib/http";

export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

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

export const requestOpenRouterChatCompletion = async ({
  apiKey,
  messages,
  model,
  origin,
  siteTitle,
}: {
  apiKey: string;
  messages: OpenRouterMessage[];
  model: string;
  origin: string;
  siteTitle: string;
}): Promise<string> => {
  const response = await fetch(OPENROUTER_API_URL, {
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
  });

  const rawText = await response.text();
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
