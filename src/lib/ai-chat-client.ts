import { AI_ASSISTANT_NAME } from "@/lib/ai-chat";

export type AiChatAttachment = {
  id: string;
  name: string;
  dataUrl: string;
};

export type AiChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments: AiChatAttachment[];
  attachmentNames: string[];
  name?: string;
  seed?: boolean;
};

export type AiChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AiChatMessage[];
};

export type AiChatWindowSize = {
  width: number;
  height: number;
};

type PersistedAiChatMessage = Omit<AiChatMessage, "attachments">;

type PersistedAiChatConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: PersistedAiChatMessage[];
};

export type PersistedAiChatState = {
  activeConversationId: string | null;
  conversations: PersistedAiChatConversation[];
};

export const AI_CHAT_STATE_COOKIE_BASE_NAME = "vicky_ai_chat_state";
export const AI_CHAT_SIZE_COOKIE_NAME = "vicky_ai_chat_size";

const MAX_PERSISTED_CONVERSATIONS = 6;
const MAX_PERSISTED_MESSAGES_PER_CONVERSATION = 24;
const MIN_MESSAGES_TO_KEEP = 4;
const MAX_SERIALIZED_COOKIE_CHARS = 18_000;

const createId = (): string => crypto.randomUUID();

export const AI_CHAT_WELCOME_TEXT = `Hi, I'm ${AI_ASSISTANT_NAME}. Ask me anything about these docs and I'll answer as helpfully as I can from the documentation context.`;

export const createWelcomeMessage = (): AiChatMessage => ({
  id: createId(),
  role: "assistant",
  text: AI_CHAT_WELCOME_TEXT,
  createdAt: new Date().toISOString(),
  attachments: [],
  attachmentNames: [],
  name: AI_ASSISTANT_NAME,
  seed: true,
});

export const createEmptyConversation = (): AiChatConversation => {
  const createdAt = new Date().toISOString();

  return {
    id: createId(),
    title: "New chat",
    createdAt,
    updatedAt: createdAt,
    messages: [createWelcomeMessage()],
  };
};

export const createUserMessage = (text: string, attachments: AiChatAttachment[]): AiChatMessage => ({
  id: createId(),
  role: "user",
  text,
  createdAt: new Date().toISOString(),
  attachments,
  attachmentNames: attachments.map((attachment) => attachment.name),
});

export const createAssistantMessage = (text: string): AiChatMessage => ({
  id: createId(),
  role: "assistant",
  text,
  createdAt: new Date().toISOString(),
  attachments: [],
  attachmentNames: [],
  name: AI_ASSISTANT_NAME,
});

export const deriveConversationTitle = (messages: AiChatMessage[]): string => {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return "New chat";
  }

  const firstLine = firstUserMessage.text.trim().split(/\r?\n/, 1)[0] ?? "";
  if (firstLine) {
    return firstLine.length <= 42 ? firstLine : `${firstLine.slice(0, 39).trimEnd()}...`;
  }

  if (firstUserMessage.attachmentNames.length > 0) {
    return firstUserMessage.attachmentNames.length === 1
      ? firstUserMessage.attachmentNames[0]
      : `${firstUserMessage.attachmentNames.length} uploaded images`;
  }

  return "New chat";
};

const toPersistedMessage = (message: AiChatMessage): PersistedAiChatMessage => ({
  id: message.id,
  role: message.role,
  text: message.text,
  createdAt: message.createdAt,
  attachmentNames: [...message.attachmentNames],
  ...(message.name ? { name: message.name } : {}),
  ...(message.seed ? { seed: true } : {}),
});

const toPersistedConversation = (conversation: AiChatConversation): PersistedAiChatConversation => ({
  id: conversation.id,
  title: conversation.title,
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
  messages: conversation.messages.map((message) => toPersistedMessage(message)),
});

const trimLongestMessage = (state: PersistedAiChatState): boolean => {
  let targetConversation: PersistedAiChatConversation | null = null;
  let targetMessage: PersistedAiChatMessage | null = null;

  for (const conversation of state.conversations) {
    for (const message of conversation.messages) {
      if (!message.text || message.text.length <= 280) {
        continue;
      }

      if (!targetMessage || message.text.length > targetMessage.text.length) {
        targetConversation = conversation;
        targetMessage = message;
      }
    }
  }

  if (!targetConversation || !targetMessage) {
    return false;
  }

  const index = targetConversation.messages.findIndex((message) => message.id === targetMessage?.id);
  if (index === -1) {
    return false;
  }

  targetConversation.messages[index] = {
    ...targetMessage,
    text: `${targetMessage.text.slice(0, 260).trimEnd()}...`,
  };

  return true;
};

export const compactPersistedAiChatState = (input: PersistedAiChatState): PersistedAiChatState => {
  const state: PersistedAiChatState = {
    activeConversationId: input.activeConversationId,
    conversations: input.conversations.slice(-MAX_PERSISTED_CONVERSATIONS).map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_PERSISTED_MESSAGES_PER_CONVERSATION),
    })),
  };

  if (!state.conversations.some((conversation) => conversation.id === state.activeConversationId)) {
    state.activeConversationId = state.conversations.at(-1)?.id ?? null;
  }

  let encoded = encodeURIComponent(JSON.stringify(state));

  while (encoded.length > MAX_SERIALIZED_COOKIE_CHARS) {
    if (state.conversations.length > 1) {
      state.conversations.shift();
      if (!state.conversations.some((conversation) => conversation.id === state.activeConversationId)) {
        state.activeConversationId = state.conversations.at(-1)?.id ?? null;
      }
      encoded = encodeURIComponent(JSON.stringify(state));
      continue;
    }

    const onlyConversation = state.conversations[0];
    if (!onlyConversation) {
      break;
    }

    if (onlyConversation.messages.length > MIN_MESSAGES_TO_KEEP) {
      onlyConversation.messages.shift();
      encoded = encodeURIComponent(JSON.stringify(state));
      continue;
    }

    if (!trimLongestMessage(state)) {
      break;
    }

    encoded = encodeURIComponent(JSON.stringify(state));
  }

  return state;
};

export const serializeAiChatState = (
  conversations: AiChatConversation[],
  activeConversationId: string | null,
): string => {
  const persisted = compactPersistedAiChatState({
    activeConversationId,
    conversations: conversations.map((conversation) => toPersistedConversation(conversation)),
  });

  return encodeURIComponent(JSON.stringify(persisted));
};

const normalizePersistedMessage = (value: unknown): PersistedAiChatMessage | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id : "";
  const role = source.role === "assistant" ? "assistant" : source.role === "user" ? "user" : null;
  const createdAt = typeof source.createdAt === "string" ? source.createdAt : "";
  const text = typeof source.text === "string" ? source.text : "";
  const attachmentNames = Array.isArray(source.attachmentNames)
    ? source.attachmentNames.filter((entry): entry is string => typeof entry === "string")
    : [];
  const name = typeof source.name === "string" ? source.name : undefined;
  const seed = source.seed === true;

  if (!id || !role || !createdAt) {
    return null;
  }

  return {
    id,
    role,
    text,
    createdAt,
    attachmentNames,
    ...(name ? { name } : {}),
    ...(seed ? { seed: true } : {}),
  };
};

const normalizePersistedConversation = (value: unknown): PersistedAiChatConversation | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const source = value as Record<string, unknown>;
  const id = typeof source.id === "string" ? source.id : "";
  const title = typeof source.title === "string" ? source.title : "New chat";
  const createdAt = typeof source.createdAt === "string" ? source.createdAt : "";
  const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : createdAt;
  const messages = Array.isArray(source.messages) ? source.messages.map((message) => normalizePersistedMessage(message)).filter(Boolean) : [];

  if (!id || !createdAt) {
    return null;
  }

  return {
    id,
    title,
    createdAt,
    updatedAt,
    messages: messages as PersistedAiChatMessage[],
  };
};

export const deserializeAiChatState = (encoded: string): PersistedAiChatState | null => {
  if (!encoded.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const source = parsed as Record<string, unknown>;
    const conversations = Array.isArray(source.conversations)
      ? source.conversations.map((conversation) => normalizePersistedConversation(conversation)).filter(Boolean)
      : [];
    const activeConversationId = typeof source.activeConversationId === "string" ? source.activeConversationId : null;

    return compactPersistedAiChatState({
      activeConversationId,
      conversations: conversations as PersistedAiChatConversation[],
    });
  } catch {
    return null;
  }
};

export const restoreAiChatConversations = (state: PersistedAiChatState | null): {
  conversations: AiChatConversation[];
  activeConversationId: string | null;
} => {
  if (!state || state.conversations.length === 0) {
    const freshConversation = createEmptyConversation();
    return {
      conversations: [freshConversation],
      activeConversationId: freshConversation.id,
    };
  }

  const conversations = state.conversations.map<AiChatConversation>((conversation) => {
    const messages =
      conversation.messages.length > 0
        ? conversation.messages.map<AiChatMessage>((message) => ({
            id: message.id,
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
            attachments: [],
            attachmentNames: [...message.attachmentNames],
            ...(message.name ? { name: message.name } : {}),
            ...(message.seed ? { seed: true } : {}),
          }))
        : [createWelcomeMessage()];

    return {
      id: conversation.id,
      title: conversation.title || deriveConversationTitle(messages),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt || messages.at(-1)?.createdAt || conversation.createdAt,
      messages,
    };
  });

  const activeConversationId =
    state.activeConversationId && conversations.some((conversation) => conversation.id === state.activeConversationId)
      ? state.activeConversationId
      : conversations.at(-1)?.id ?? null;

  return {
    conversations,
    activeConversationId,
  };
};

export const splitCookieValue = (value: string, chunkSize = 3000): string[] => {
  const chunks: string[] = [];

  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }

  return chunks;
};
