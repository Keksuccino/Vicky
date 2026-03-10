import {
  DEFAULT_AI_CHAT_ASSISTANT_NAME,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  normalizeAiAssistantName,
  normalizeAiChatWelcomeMessage,
  renderAiChatAssistantTemplate,
} from "@/lib/ai-chat";

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

export const getAiChatWelcomeText = (
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
  welcomeMessage = DEFAULT_AI_CHAT_WELCOME_MESSAGE,
): string =>
  renderAiChatAssistantTemplate(
    normalizeAiChatWelcomeMessage(welcomeMessage),
    assistantName,
    DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  );

export const createWelcomeMessage = (
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
  welcomeMessage = DEFAULT_AI_CHAT_WELCOME_MESSAGE,
): AiChatMessage => {
  const resolvedAssistantName = normalizeAiAssistantName(assistantName);

  return {
    id: createId(),
    role: "assistant",
    text: getAiChatWelcomeText(resolvedAssistantName, welcomeMessage),
    createdAt: new Date().toISOString(),
    attachments: [],
    attachmentNames: [],
    name: resolvedAssistantName,
    seed: true,
  };
};

export const createEmptyConversation = (
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
  welcomeMessage = DEFAULT_AI_CHAT_WELCOME_MESSAGE,
): AiChatConversation => {
  const createdAt = new Date().toISOString();

  return {
    id: createId(),
    title: "New chat",
    createdAt,
    updatedAt: createdAt,
    messages: [createWelcomeMessage(assistantName, welcomeMessage)],
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

export const createAssistantMessage = (
  text: string,
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
): AiChatMessage => ({
  id: createId(),
  role: "assistant",
  text,
  createdAt: new Date().toISOString(),
  attachments: [],
  attachmentNames: [],
  name: normalizeAiAssistantName(assistantName),
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

const applyAssistantSettingsToMessage = (
  message: AiChatMessage,
  assistantName: string,
  welcomeMessage: string,
): AiChatMessage => {
  if (message.role !== "assistant") {
    return message;
  }

  const nextText = message.seed ? getAiChatWelcomeText(assistantName, welcomeMessage) : message.text;
  if (message.name === assistantName && message.text === nextText) {
    return message;
  }

  return {
    ...message,
    text: nextText,
    name: assistantName,
  };
};

export const syncAiChatConversationAssistantName = (
  conversations: AiChatConversation[],
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
  welcomeMessage = DEFAULT_AI_CHAT_WELCOME_MESSAGE,
): AiChatConversation[] => {
  const resolvedAssistantName = normalizeAiAssistantName(assistantName);
  const resolvedWelcomeMessage = normalizeAiChatWelcomeMessage(welcomeMessage);
  let changed = false;

  const nextConversations = conversations.map((conversation) => {
    let conversationChanged = false;

    const messages = conversation.messages.map((message) => {
      const updatedMessage = applyAssistantSettingsToMessage(message, resolvedAssistantName, resolvedWelcomeMessage);
      if (updatedMessage !== message) {
        conversationChanged = true;
      }

      return updatedMessage;
    });

    if (!conversationChanged) {
      return conversation;
    }

    changed = true;
    return {
      ...conversation,
      messages,
    };
  });

  return changed ? nextConversations : conversations;
};

export const restoreAiChatConversations = (state: PersistedAiChatState | null): {
  conversations: AiChatConversation[];
  activeConversationId: string | null;
} => restoreAiChatConversationsWithSettings(state);

export const deleteAiChatConversation = (
  conversations: AiChatConversation[],
  activeConversationId: string | null,
  deletedConversationId: string,
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
  welcomeMessage = DEFAULT_AI_CHAT_WELCOME_MESSAGE,
): {
  conversations: AiChatConversation[];
  activeConversationId: string | null;
} => {
  const deletedIndex = conversations.findIndex((conversation) => conversation.id === deletedConversationId);
  if (deletedIndex === -1) {
    return {
      conversations,
      activeConversationId,
    };
  }

  const remainingConversations = conversations.filter((conversation) => conversation.id !== deletedConversationId);
  if (remainingConversations.length === 0) {
    const freshConversation = createEmptyConversation(assistantName, welcomeMessage);

    return {
      conversations: [freshConversation],
      activeConversationId: freshConversation.id,
    };
  }

  if (activeConversationId === deletedConversationId) {
    return {
      conversations: remainingConversations,
      activeConversationId:
        remainingConversations[deletedIndex]?.id ??
        remainingConversations[deletedIndex - 1]?.id ??
        remainingConversations.at(-1)?.id ??
        null,
    };
  }

  return {
    conversations: remainingConversations,
    activeConversationId:
      activeConversationId && remainingConversations.some((conversation) => conversation.id === activeConversationId)
        ? activeConversationId
        : remainingConversations.at(-1)?.id ?? null,
  };
};

export const restoreAiChatConversationsWithSettings = (
  state: PersistedAiChatState | null,
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
  welcomeMessage = DEFAULT_AI_CHAT_WELCOME_MESSAGE,
): {
  conversations: AiChatConversation[];
  activeConversationId: string | null;
} => {
  const resolvedAssistantName = normalizeAiAssistantName(assistantName);
  const resolvedWelcomeMessage = normalizeAiChatWelcomeMessage(welcomeMessage);

  if (!state || state.conversations.length === 0) {
    const freshConversation = createEmptyConversation(resolvedAssistantName, resolvedWelcomeMessage);
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
        : [createWelcomeMessage(resolvedAssistantName, resolvedWelcomeMessage)];

    return {
      id: conversation.id,
      title: conversation.title || deriveConversationTitle(messages),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt || messages.at(-1)?.createdAt || conversation.createdAt,
      messages: messages.map((message) =>
        applyAssistantSettingsToMessage(message, resolvedAssistantName, resolvedWelcomeMessage),
      ),
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
