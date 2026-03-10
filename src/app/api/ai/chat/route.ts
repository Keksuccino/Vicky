import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";

import {
  normalizeAiAssistantName,
  extractAiAssistantText,
  injectDocsIntoSystemPrompt,
  MAX_AI_CHAT_HISTORY_MESSAGES,
  MAX_AI_CHAT_IMAGE_BYTES,
  MAX_AI_CHAT_IMAGES_PER_MESSAGE,
  MAX_AI_CHAT_MESSAGE_LENGTH,
} from "@/lib/ai-chat";
import { consumeAiChatRateLimit } from "@/lib/ai-chat-rate-limit";
import { setDocsCacheTtlMs } from "@/lib/cache";
import { getPlaintextDocsExport } from "@/lib/docs-plaintext";
import { decryptSecret } from "@/lib/encryption";
import { resolveRuntimeConfig } from "@/lib/github";
import { ApiError, badRequest, errorResponse, parseJsonBody } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_IMAGE_COUNT = MAX_AI_CHAT_IMAGES_PER_MESSAGE;
const MAX_MESSAGES = MAX_AI_CHAT_HISTORY_MESSAGES;
const MAX_TEXT_LENGTH = MAX_AI_CHAT_MESSAGE_LENGTH;
const MAX_IMAGE_DATA_URL_LENGTH = Math.ceil(MAX_AI_CHAT_IMAGE_BYTES * 1.5);

const imageSchema = z
  .object({
    name: z.string().max(160).optional(),
    dataUrl: z.string().max(MAX_IMAGE_DATA_URL_LENGTH),
  })
  .strict();

const messageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(MAX_TEXT_LENGTH).optional(),
    images: z.array(imageSchema).max(MAX_IMAGE_COUNT).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const trimmedText = value.text?.trim() ?? "";
    const images = value.images ?? [];

    if (!trimmedText && images.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each chat message must include text, images, or both.",
      });
    }

    if (value.role === "assistant" && images.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Assistant history messages cannot include images.",
      });
    }
  });

const requestSchema = z
  .object({
    messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.messages.at(-1)?.role !== "user") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages"],
        message: "The latest chat message must be a user message.",
      });
    }
  });

const DATA_URL_PREFIX = /^data:(image\/(?:png|jpe?g|webp|gif));base64,[a-z0-9+/=\s]+$/i;

const safeJsonParse = (input: string): unknown => {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
};

const resolveRequestOrigin = (request: NextRequest): string => {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return request.nextUrl.origin;
};

const assertValidImageDataUrl = (dataUrl: string): void => {
  if (!DATA_URL_PREFIX.test(dataUrl)) {
    throw badRequest("Only PNG, JPEG, WEBP, and GIF image uploads are supported.");
  }
};

const toOpenRouterMessage = (message: z.infer<typeof messageSchema>) => {
  const trimmedText = message.text?.trim() ?? "";
  const images = message.images ?? [];

  if (message.role === "assistant") {
    return {
      role: "assistant" as const,
      content: trimmedText,
    };
  }

  if (images.length === 0) {
    return {
      role: "user" as const,
      content: trimmedText,
    };
  }

  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];

  if (trimmedText) {
    parts.push({
      type: "text",
      text: trimmedText,
    });
  }

  for (const image of images) {
    assertValidImageDataUrl(image.dataUrl);
    parts.push({
      type: "image_url",
      image_url: {
        url: image.dataUrl,
      },
    });
  }

  return {
    role: "user" as const,
    content: parts,
  };
};

const extractErrorMessage = (payload: unknown, fallback: string): string => {
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

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  try {
    const rateLimit = consumeAiChatRateLimit(request);
    if (rateLimit.blocked) {
      return NextResponse.json(
        {
          error: `Too many AI chat requests. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimit.retryAfterSeconds),
          },
        },
      );
    }

    const body = await parseJsonBody<unknown>(request);
    const payload = requestSchema.parse(body);

    const store = await getStore();
    if (!store.settings.aiChat.enabled) {
      throw new ApiError(404, "AI chat is disabled.");
    }

    if (!store.settings.aiChat.openRouterApiKeyEncrypted || !store.settings.aiChat.openRouterModel.trim()) {
      throw new ApiError(503, "AI chat is not fully configured.");
    }

    setDocsCacheTtlMs(store.settings.docsCacheTtlMs);

    const origin = resolveRequestOrigin(request);
    const docsConfig = resolveRuntimeConfig(store.settings.github);
    const docsText = await getPlaintextDocsExport(docsConfig, origin);
    const assistantName = normalizeAiAssistantName(store.settings.aiChat.assistantName);
    const systemPrompt = injectDocsIntoSystemPrompt(store.settings.aiChat.systemPrompt, docsText, assistantName);
    const messages = payload.messages.map((message) => toOpenRouterMessage(message));

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${decryptSecret(store.settings.aiChat.openRouterApiKeyEncrypted).trim()}`,
        "Content-Type": "application/json",
        "HTTP-Referer": origin,
        "X-Title": store.settings.siteTitle || "Vicky Docs",
      },
      body: JSON.stringify({
        model: store.settings.aiChat.openRouterModel.trim(),
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          ...messages,
        ],
      }),
      cache: "no-store",
    });

    const rawText = await response.text();
    const parsed = rawText ? safeJsonParse(rawText) : null;

    if (!response.ok) {
      throw new ApiError(response.status, extractErrorMessage(parsed, "OpenRouter request failed."));
    }

    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const firstChoice = choices[0];
    const message =
      typeof firstChoice === "object" && firstChoice !== null
        ? ((firstChoice as Record<string, unknown>).message as Record<string, unknown> | undefined)
        : undefined;
    const assistantText = extractAiAssistantText(message?.content);

    if (!assistantText) {
      throw new ApiError(502, "OpenRouter returned an empty response.");
    }

    return NextResponse.json({
      reply: {
        role: "assistant",
        text: assistantText,
        name: assistantName,
      },
    });
  } catch (error: unknown) {
    return errorResponse(error);
  }
};
