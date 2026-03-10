import { describe, expect, it } from "vitest";

import {
  AI_CHAT_DOCS_PLACEHOLDER,
  DEFAULT_AI_CHAT_SYSTEM_PROMPT,
  renderAiChatSystemPrompt,
} from "../ai-chat";
import { compactPersistedAiChatState, deserializeAiChatState } from "../ai-chat-client";

describe("ai chat system prompt", () => {
  it("injects docs text into the configured placeholder", () => {
    const docsText = "BEGIN PAGE: https://docs.example.com/docs/home\n# Home";
    const rendered = renderAiChatSystemPrompt(DEFAULT_AI_CHAT_SYSTEM_PROMPT, docsText);

    expect(rendered).toContain(docsText);
    expect(rendered).not.toContain(AI_CHAT_DOCS_PLACEHOLDER);
  });

  it("appends docs text when the placeholder is missing", () => {
    const rendered = renderAiChatSystemPrompt("You are Alice.", "# Docs");

    expect(rendered).toBe("You are Alice.\n\n# Docs");
  });
});

describe("ai chat persisted state", () => {
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
});
