import { describe, expect, it } from "vitest";

import {
  AI_CHAT_ASSISTANT_NAME_PLACEHOLDER,
  AI_CHAT_DOCS_PLACEHOLDER,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  buildDefaultAiChatSystemPrompt,
  renderAiChatAssistantTemplate,
  renderAiChatSystemPrompt,
} from "../ai-chat";
import {
  compactPersistedAiChatState,
  deserializeAiChatState,
  getAiChatWelcomeText,
  restoreAiChatConversationsWithSettings,
} from "../ai-chat-client";

describe("ai chat system prompt", () => {
  it("renders assistant placeholders in configurable UI text", () => {
    const rendered = renderAiChatAssistantTemplate("Meet {{assistant_name}}.", "Vicky");

    expect(rendered).toBe("Meet Vicky.");
  });

  it("injects docs text into the configured placeholder", () => {
    const docsText = "BEGIN PAGE: https://docs.example.com/docs/home\n# Home";
    const rendered = renderAiChatSystemPrompt(DEFAULT_AI_CHAT_SYSTEM_PROMPT, docsText, "Vicky");

    expect(rendered).toContain(docsText);
    expect(rendered).toContain("You are Vicky");
    expect(rendered).not.toContain(AI_CHAT_DOCS_PLACEHOLDER);
    expect(rendered).not.toContain(AI_CHAT_ASSISTANT_NAME_PLACEHOLDER);
  });

  it("appends docs text when the placeholder is missing", () => {
    const rendered = renderAiChatSystemPrompt("You are {{assistant_name}}.", "# Docs", "Vicky");

    expect(rendered).toBe("You are Vicky.\n\n# Docs");
  });

  it("upgrades the legacy default prompt to the configured assistant name", () => {
    const rendered = renderAiChatSystemPrompt(buildDefaultAiChatSystemPrompt("Alice"), "# Docs", "Vicky");

    expect(rendered).toContain("You are Vicky");
    expect(rendered).not.toContain("You are Alice");
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
});
