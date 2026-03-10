import type { AiChatSettings } from "@/lib/types";

export const DEFAULT_AI_CHAT_ASSISTANT_NAME = "Alice";
export const AI_CHAT_ASSISTANT_NAME_PLACEHOLDER = "{{assistant_name}}";
export const AI_CHAT_DOCS_PLACEHOLDER = "{{docs_txt}}";
export const DEFAULT_AI_CHAT_HEADER_SUBTITLE = "An actually useful AI chat assistant.";
export const DEFAULT_AI_CHAT_WELCOME_MESSAGE = `Hi, I'm ${AI_CHAT_ASSISTANT_NAME_PLACEHOLDER}! 🌸 Ask me anything about these docs and I'll try to help you as best as possible! 😤`;
export const DEFAULT_AI_CHAT_OPENROUTER_MODEL = "openai/gpt-5.1-codex-mini";
export const DEFAULT_OPENROUTER_MODEL = DEFAULT_AI_CHAT_OPENROUTER_MODEL;
export const MAX_AI_CHAT_HISTORY_MESSAGES = 24;
export const MAX_AI_CHAT_MESSAGE_LENGTH = 8_000;
export const MAX_AI_CHAT_IMAGES_PER_MESSAGE = 3;
export const MAX_AI_CHAT_IMAGE_BYTES = 4_000_000;

export const normalizeAiAssistantName = (
  value: unknown,
  fallback = DEFAULT_AI_CHAT_ASSISTANT_NAME,
): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

export const normalizeAiChatAvatarUrl = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
};

const normalizeAiChatTemplateString = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

export const normalizeAiChatHeaderSubtitle = (
  value: unknown,
  fallback = DEFAULT_AI_CHAT_HEADER_SUBTITLE,
): string => normalizeAiChatTemplateString(value, fallback);

export const normalizeAiChatWelcomeMessage = (
  value: unknown,
  fallback = DEFAULT_AI_CHAT_WELCOME_MESSAGE,
): string => normalizeAiChatTemplateString(value, fallback);

export const renderAiChatAssistantTemplate = (
  template: unknown,
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
  fallback = "",
): string =>
  normalizeAiChatTemplateString(template, fallback)
    .split(AI_CHAT_ASSISTANT_NAME_PLACEHOLDER)
    .join(normalizeAiAssistantName(assistantName));

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

export const buildDefaultAiChatSystemPrompt = (
  assistantName = AI_CHAT_ASSISTANT_NAME_PLACEHOLDER,
): string => `You are ${assistantName}, a friendly and wholesome AI assistant for this documentation site.

You are trained on the documentation provided below and your job is to answer questions about that documentation clearly, accurately, and helpfully.

Ground your answers in the provided docs whenever possible. If the docs do not contain the answer, say that plainly instead of inventing details.

When helpful, reference the relevant docs page URLs that appear in the documentation context.

Documentation context:
${AI_CHAT_DOCS_PLACEHOLDER}`;

const LEGACY_DEFAULT_AI_CHAT_SYSTEM_PROMPT = buildDefaultAiChatSystemPrompt(DEFAULT_AI_CHAT_ASSISTANT_NAME);

const upgradeAiChatSystemPromptTemplate = (
  template: unknown,
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
): string => {
  const trimmed = typeof template === "string" ? template.trim() : "";
  if (!trimmed) {
    return buildDefaultAiChatSystemPrompt();
  }

  const resolvedAssistantName = normalizeAiAssistantName(assistantName);
  if (
    trimmed === LEGACY_DEFAULT_AI_CHAT_SYSTEM_PROMPT ||
    trimmed === buildDefaultAiChatSystemPrompt(resolvedAssistantName)
  ) {
    return buildDefaultAiChatSystemPrompt();
  }

  return trimmed;
};

export const DEFAULT_AI_CHAT_SYSTEM_PROMPT = buildDefaultAiChatSystemPrompt();

export const normalizeAiChatSystemPromptTemplate = (
  template: unknown,
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
): string => {
  const upgradedTemplate = upgradeAiChatSystemPromptTemplate(template, assistantName);
  return upgradedTemplate.includes(AI_CHAT_DOCS_PLACEHOLDER) ? upgradedTemplate : DEFAULT_AI_CHAT_SYSTEM_PROMPT;
};

export const DEFAULT_AI_CHAT_SETTINGS = (): AiChatSettings => ({
  enabled: false,
  assistantName: DEFAULT_AI_CHAT_ASSISTANT_NAME,
  avatarUrl: "",
  headerSubtitle: DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  welcomeMessage: DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  systemPrompt: DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  openRouterModel: DEFAULT_AI_CHAT_OPENROUTER_MODEL,
  openRouterApiKeyEncrypted: null,
});

export const renderAiChatSystemPrompt = (
  template: string,
  docsText: string,
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
): string => {
  const resolvedAssistantName = normalizeAiAssistantName(assistantName);
  const resolvedTemplate = upgradeAiChatSystemPromptTemplate(template, resolvedAssistantName).split(
    AI_CHAT_ASSISTANT_NAME_PLACEHOLDER,
  ).join(resolvedAssistantName);
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
