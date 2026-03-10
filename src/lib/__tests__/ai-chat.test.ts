import { describe, expect, it } from "vitest";

import {
  AI_CHAT_ASSISTANT_NAME_PLACEHOLDER,
  AI_CHAT_DOCS_PLACEHOLDER,
  DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  buildDefaultAiChatSystemPrompt,
  normalizeAiChatSystemPromptTemplate,
  normalizeAiChatWelcomeMessage,
  renderAiChatAssistantTemplate,
  renderAiChatSystemPrompt,
} from "../ai-chat";
import {
  compactPersistedAiChatState,
  deleteAiChatConversation,
  deserializeAiChatState,
  getAiChatWelcomeText,
  restoreAiChatConversationsWithSettings,
} from "../ai-chat-client";

describe("ai chat system prompt", () => {
  it("renders assistant placeholders in configurable UI text", () => {
    const rendered = renderAiChatAssistantTemplate("Meet {{assistant_name}}.", "Vicky");

    expect(rendered).toBe("Meet Vicky.");
  });

  it("preserves trailing blank lines in welcome templates", () => {
    const template = "Meet {{assistant_name}}.\n\n";

    expect(normalizeAiChatWelcomeMessage(template)).toBe(template);
    expect(renderAiChatAssistantTemplate(template, "Vicky")).toBe("Meet Vicky.\n\n");
  });

  it("injects docs text into the configured placeholder", () => {
    const docsText = "BEGIN PAGE: https://docs.example.com/docs/home\n# Home";
    const rendered = renderAiChatSystemPrompt(DEFAULT_AI_CHAT_SYSTEM_PROMPT, docsText, "Vicky");

    expect(rendered).toContain(docsText);
    expect(rendered).toContain("Your name is Vicky.");
    expect(rendered).not.toContain(AI_CHAT_DOCS_PLACEHOLDER);
    expect(rendered).not.toContain(AI_CHAT_ASSISTANT_NAME_PLACEHOLDER);
  });

  it("appends docs text when the placeholder is missing", () => {
    const rendered = renderAiChatSystemPrompt("You are {{assistant_name}}.", "# Docs", "Vicky");

    expect(rendered).toBe("You are Vicky.\n\n# Docs");
  });

  it("upgrades the legacy default prompt to the configured assistant name", () => {
    const rendered = renderAiChatSystemPrompt(buildDefaultAiChatSystemPrompt("Alice"), "# Docs", "Vicky");

    expect(rendered).toContain("Your name is Vicky.");
    expect(rendered).not.toContain("Your name is Alice.");
  });

  it("upgrades the previous built-in default prompt to the new template", () => {
    const previousTemplate = `You are Alice, a friendly and wholesome AI assistant for this documentation site.

You are trained on the documentation provided below and your job is to answer questions about that documentation clearly, accurately, and helpfully.

Ground your answers in the provided docs whenever possible. If the docs do not contain the answer, say that plainly instead of inventing details.

When helpful, reference the relevant docs page URLs that appear in the documentation context.

Documentation context:
${AI_CHAT_DOCS_PLACEHOLDER}`;
    const rendered = renderAiChatSystemPrompt(previousTemplate, "# Docs", "Vicky");

    expect(rendered).toContain("Your name is Vicky.");
    expect(rendered).not.toContain("friendly and wholesome");
  });

  it("preserves trailing blank lines in custom system prompts", () => {
    const template = `${DEFAULT_AI_CHAT_SYSTEM_PROMPT}\n\n`;

    expect(normalizeAiChatSystemPromptTemplate(template, "Vicky")).toBe(template);
  });
});

describe("ai chat persisted state", () => {
  it("renders the welcome template with the configured assistant name", () => {
    expect(getAiChatWelcomeText("Vicky", DEFAULT_AI_CHAT_WELCOME_MESSAGE)).toContain("Hi, I'm Vicky!");
  });

  it("keeps the active conversation available after compaction", () => {
    const compacted = compactPersistedAiChatState({
      activeConversationId: "conversation-8",
      conversations: Array.from({ length: 8 }, (_, index) => ({
        id: `conversation-${index + 1}`,
        title: `Chat ${index + 1}`,
        createdAt: `2026-03-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        updatedAt: `2026-03-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        messages: [
          {
            id: `message-${index + 1}`,
            role: "user" as const,
            text: `Question ${index + 1}`,
            createdAt: `2026-03-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
            attachmentNames: [],
          },
        ],
      })),
    });

    expect(compacted.conversations).toHaveLength(6);
    expect(compacted.activeConversationId).toBe("conversation-8");
    expect(compacted.conversations.some((conversation) => conversation.id === "conversation-8")).toBe(true);
    expect(compacted.conversations.some((conversation) => conversation.id === "conversation-1")).toBe(false);
  });

  it("round-trips a serialized chat cookie payload", () => {
    const serialized = encodeURIComponent(
      JSON.stringify({
        activeConversationId: "conversation-1",
        conversations: [
          {
            id: "conversation-1",
            title: "Hello",
            createdAt: "2026-03-10T00:00:00.000Z",
            updatedAt: "2026-03-10T00:00:00.000Z",
            messages: [
              {
                id: "message-1",
                role: "assistant",
                text: "Hi there",
                createdAt: "2026-03-10T00:00:00.000Z",
                attachmentNames: [],
                seed: true,
              },
            ],
          },
        ],
      }),
    );

    const parsed = deserializeAiChatState(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed?.activeConversationId).toBe("conversation-1");
    expect(parsed?.conversations[0]?.messages[0]?.text).toBe("Hi there");
  });

  it("updates seeded welcome messages when restoring with custom settings", () => {
    const restored = restoreAiChatConversationsWithSettings(
      {
        activeConversationId: "conversation-1",
        conversations: [
          {
            id: "conversation-1",
            title: "Hello",
            createdAt: "2026-03-10T00:00:00.000Z",
            updatedAt: "2026-03-10T00:00:00.000Z",
            messages: [
              {
                id: "message-1",
                role: "assistant",
                text: "Old welcome",
                createdAt: "2026-03-10T00:00:00.000Z",
                attachmentNames: [],
                seed: true,
              },
            ],
          },
        ],
      },
      "Vicky",
      "Welcome to the docs, {{assistant_name}}.",
    );

    expect(restored.conversations[0]?.messages[0]?.text).toBe("Welcome to the docs, Vicky.");
    expect(restored.conversations[0]?.messages[0]?.name).toBe("Vicky");
  });

  it("keeps the current active conversation when deleting a different chat", () => {
    const deleted = deleteAiChatConversation(
      [
        {
          id: "conversation-1",
          title: "First",
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: "2026-03-10T00:00:00.000Z",
          messages: [],
        },
        {
          id: "conversation-2",
          title: "Second",
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
          messages: [],
        },
      ],
      "conversation-2",
      "conversation-1",
    );

    expect(deleted.conversations).toHaveLength(1);
    expect(deleted.conversations[0]?.id).toBe("conversation-2");
    expect(deleted.activeConversationId).toBe("conversation-2");
  });

  it("selects the next available chat when deleting the active conversation", () => {
    const deleted = deleteAiChatConversation(
      [
        {
          id: "conversation-1",
          title: "First",
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: "2026-03-10T00:00:00.000Z",
          messages: [],
        },
        {
          id: "conversation-2",
          title: "Second",
          createdAt: "2026-03-11T00:00:00.000Z",
          updatedAt: "2026-03-11T00:00:00.000Z",
          messages: [],
        },
        {
          id: "conversation-3",
          title: "Third",
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
          messages: [],
        },
      ],
      "conversation-2",
      "conversation-2",
    );

    expect(deleted.conversations.map((conversation) => conversation.id)).toEqual(["conversation-1", "conversation-3"]);
    expect(deleted.activeConversationId).toBe("conversation-3");
  });

  it("creates a fresh chat when deleting the final remaining conversation", () => {
    const deleted = deleteAiChatConversation(
      [
        {
          id: "conversation-1",
          title: "First",
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: "2026-03-10T00:00:00.000Z",
          messages: [],
        },
      ],
      "conversation-1",
      "conversation-1",
      "Vicky",
      "Welcome back, {{assistant_name}}.",
    );

    expect(deleted.conversations).toHaveLength(1);
    expect(deleted.conversations[0]?.id).toBe(deleted.activeConversationId);
    expect(deleted.conversations[0]?.title).toBe("New chat");
    expect(deleted.conversations[0]?.messages[0]?.text).toBe("Welcome back, Vicky.");
  });
});
