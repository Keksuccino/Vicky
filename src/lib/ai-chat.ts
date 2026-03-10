import type { AiChatSettings } from "@/lib/types";

export const AI_CHAT_ASSISTANT_NAME = "Alice";
export const AI_ASSISTANT_NAME = AI_CHAT_ASSISTANT_NAME;
export const AI_CHAT_DOCS_PLACEHOLDER = "{{docs_txt}}";
export const DEFAULT_AI_CHAT_OPENROUTER_MODEL = "openai/gpt-5.1-codex-mini";
export const DEFAULT_OPENROUTER_MODEL = DEFAULT_AI_CHAT_OPENROUTER_MODEL;
export const MAX_AI_CHAT_HISTORY_MESSAGES = 24;
export const MAX_AI_CHAT_MESSAGE_LENGTH = 8_000;
export const MAX_AI_CHAT_IMAGES_PER_MESSAGE = 3;
export const MAX_AI_CHAT_IMAGE_BYTES = 4_000_000;

export interface AiChatRequestImage {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface AiChatRequestMessage {
  role: "user" | "assistant";
  text: string;
  images?: AiChatRequestImage[];
}

export const DEFAULT_AI_CHAT_SYSTEM_PROMPT = `You are ${AI_CHAT_ASSISTANT_NAME}, a friendly and wholesome AI assistant for this documentation site.

You are trained on the documentation provided below and your job is to answer questions about that documentation clearly, accurately, and helpfully.

Ground your answers in the provided docs whenever possible. If the docs do not contain the answer, say that plainly instead of inventing details.

When helpful, reference the relevant docs page URLs that appear in the documentation context.

Documentation context:
${AI_CHAT_DOCS_PLACEHOLDER}`;

export const DEFAULT_AI_CHAT_SETTINGS = (): AiChatSettings => ({
  enabled: false,
  systemPrompt: DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  openRouterModel: DEFAULT_AI_CHAT_OPENROUTER_MODEL,
  openRouterApiKeyEncrypted: null,
});

export const renderAiChatSystemPrompt = (template: string, docsText: string): string => {
  const resolvedTemplate = template.trim() || DEFAULT_AI_CHAT_SYSTEM_PROMPT;
  const docsBlock = docsText.trim();

  if (!resolvedTemplate.includes(AI_CHAT_DOCS_PLACEHOLDER)) {
    return [resolvedTemplate, docsBlock].filter(Boolean).join("\n\n");
  }

  return resolvedTemplate.split(AI_CHAT_DOCS_PLACEHOLDER).join(docsBlock);
};

export const injectDocsIntoSystemPrompt = renderAiChatSystemPrompt;

export const extractAiAssistantText = (content: unknown): string => {
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
