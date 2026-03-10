"use client";

import {
  type CSSProperties,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import { fetchPublicSiteSettings, formatApiError, sendDocsAiChatMessage } from "@/components/api";
import { cn } from "@/components/cn";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MaterialIcon } from "@/components/material-icon";
import {
  AI_CHAT_SIZE_COOKIE_NAME,
  AI_CHAT_STATE_COOKIE_BASE_NAME,
  type AiChatAttachment,
  type AiChatConversation,
  type AiChatMessage,
  type AiChatWindowSize,
  createAssistantMessage,
  deleteAiChatConversation,
  createEmptyConversation,
  createUserMessage,
  deriveConversationTitle,
  deserializeAiChatState,
  restoreAiChatConversationsWithSettings,
  serializeAiChatState,
  splitCookieValue,
  syncAiChatConversationAssistantName,
} from "@/lib/ai-chat-client";
import {
  DEFAULT_AI_CHAT_ASSISTANT_NAME,
  DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  DEFAULT_AI_CHAT_WELCOME_MESSAGE,
  MAX_AI_CHAT_IMAGE_BYTES,
  MAX_AI_CHAT_IMAGES_PER_MESSAGE,
  renderAiChatAssistantTemplate,
} from "@/lib/ai-chat";

const CHAT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const CHAT_COOKIE_MAX_CHUNKS = 8;
const CHAT_COOKIE_COUNT_NAME = `${AI_CHAT_STATE_COOKIE_BASE_NAME}_count`;
const DEFAULT_WINDOW_SIZE: AiChatWindowSize = {
  width: 420,
  height: 640,
};
const MIN_WINDOW_WIDTH = 360;
const MAX_WINDOW_WIDTH = 760;
const MIN_WINDOW_HEIGHT = 460;
const MAX_WINDOW_HEIGHT = 860;

const createInitialConversationState = (
  assistantName = DEFAULT_AI_CHAT_ASSISTANT_NAME,
  welcomeMessage = DEFAULT_AI_CHAT_WELCOME_MESSAGE,
): {
  conversations: AiChatConversation[];
  activeConversationId: string | null;
} => {
  const conversation = createEmptyConversation(assistantName, welcomeMessage);

  return {
    conversations: [conversation],
    activeConversationId: conversation.id,
  };
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

const clampWindowSize = (value: AiChatWindowSize): AiChatWindowSize => ({
  width: clamp(value.width, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
  height: clamp(value.height, MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT),
});

const readCookie = (name: string): string => {
  if (typeof document === "undefined") {
    return "";
  }

  const prefix = `${name}=`;
  const match = document.cookie
    .split(";")
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk.startsWith(prefix));

  return match ? match.slice(prefix.length) : "";
};

const writeCookie = (name: string, value: string, maxAgeSeconds = CHAT_COOKIE_MAX_AGE_SECONDS): void => {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${name}=${value}; path=/; max-age=${maxAgeSeconds}; samesite=lax`;
};

const clearCookie = (name: string): void => {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${name}=; path=/; max-age=0; samesite=lax`;
};

const loadStoredChatState = () => {
  const count = Number.parseInt(readCookie(CHAT_COOKIE_COUNT_NAME), 10);
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }

  const chunks: string[] = [];

  for (let index = 0; index < Math.min(count, CHAT_COOKIE_MAX_CHUNKS); index += 1) {
    const value = readCookie(`${AI_CHAT_STATE_COOKIE_BASE_NAME}_${index}`);
    if (!value) {
      return null;
    }

    chunks.push(value);
  }

  return deserializeAiChatState(chunks.join(""));
};

const persistChatState = (conversations: AiChatConversation[], activeConversationId: string | null): void => {
  const serialized = serializeAiChatState(conversations, activeConversationId);
  const chunks = splitCookieValue(serialized);

  writeCookie(CHAT_COOKIE_COUNT_NAME, String(chunks.length));

  for (let index = 0; index < CHAT_COOKIE_MAX_CHUNKS; index += 1) {
    const cookieName = `${AI_CHAT_STATE_COOKIE_BASE_NAME}_${index}`;
    const chunk = chunks[index];

    if (chunk) {
      writeCookie(cookieName, chunk);
      continue;
    }

    clearCookie(cookieName);
  }
};

const loadStoredWindowSize = (): AiChatWindowSize | null => {
  const raw = readCookie(AI_CHAT_SIZE_COOKIE_NAME);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const source = parsed as Record<string, unknown>;
    const width = typeof source.width === "number" ? source.width : Number.NaN;
    const height = typeof source.height === "number" ? source.height : Number.NaN;

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }

    return clampWindowSize({
      width,
      height,
    });
  } catch {
    return null;
  }
};

const persistWindowSize = (size: AiChatWindowSize): void => {
  writeCookie(AI_CHAT_SIZE_COOKIE_NAME, encodeURIComponent(JSON.stringify(clampWindowSize(size))));
};

const formatUpdatedAt = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return "Recent";
  }

  return parsed.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
};

const readImageAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }

      resolve(result);
    };

    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });

const toApiMessages = (messages: AiChatMessage[]) =>
  messages
    .filter((message, index) => !(index === 0 && message.role === "assistant" && message.seed === true))
    .map((message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant" as const,
          text: message.text,
        };
      }

      const fallbackAttachmentNote =
        message.attachments.length === 0 && message.attachmentNames.length > 0
          ? `\n\n[Previously shared images: ${message.attachmentNames.join(", ")}]`
          : "";
      const text = `${message.text}${fallbackAttachmentNote}`.trim();

      return {
        role: "user" as const,
        ...(text ? { text } : {}),
        ...(message.attachments.length > 0
          ? {
              images: message.attachments.map((attachment) => ({
                name: attachment.name,
                dataUrl: attachment.dataUrl,
              })),
            }
          : {}),
      };
    });

export function DocsAiChat() {
  const initialStateRef = useRef<ReturnType<typeof createInitialConversationState> | null>(null);
  if (!initialStateRef.current) {
    initialStateRef.current = createInitialConversationState();
  }
  const [assistantName, setAssistantName] = useState(DEFAULT_AI_CHAT_ASSISTANT_NAME);
  const [assistantAvatarUrl, setAssistantAvatarUrl] = useState("");
  const [headerSubtitle, setHeaderSubtitle] = useState(DEFAULT_AI_CHAT_HEADER_SUBTITLE);
  const [welcomeMessage, setWelcomeMessage] = useState(DEFAULT_AI_CHAT_WELCOME_MESSAGE);
  const [featureReady, setFeatureReady] = useState(false);
  const [featureEnabled, setFeatureEnabled] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<AiChatAttachment[]>([]);
  const [windowSize, setWindowSize] = useState<AiChatWindowSize>(DEFAULT_WINDOW_SIZE);
  const [isCompactViewport, setIsCompactViewport] = useState(false);
  const [conversations, setConversations] = useState<AiChatConversation[]>(() => initialStateRef.current?.conversations ?? []);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    () => initialStateRef.current?.activeConversationId ?? null,
  );
  const [cookiesHydrated, setCookiesHydrated] = useState(false);
  const [avatarLoadFailed, setAvatarLoadFailed] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations.at(-1) ?? null;
  const resolvedHeaderSubtitle = renderAiChatAssistantTemplate(
    headerSubtitle,
    assistantName,
    DEFAULT_AI_CHAT_HEADER_SUBTITLE,
  );
  const resolvedAssistantAvatarUrl = assistantAvatarUrl.trim();
  const showAssistantAvatar = resolvedAssistantAvatarUrl.length > 0 && !avatarLoadFailed;

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      try {
        const settings = await fetchPublicSiteSettings();
        if (!mounted) {
          return;
        }

        setFeatureEnabled(settings.aiChatEnabled);
        setAssistantName(settings.aiChatAssistantName);
        setAssistantAvatarUrl(settings.aiChatAvatarUrl);
        setHeaderSubtitle(settings.aiChatHeaderSubtitle);
        setWelcomeMessage(settings.aiChatWelcomeMessage);
        setAvatarLoadFailed(false);
      } catch {
        if (!mounted) {
          return;
        }

        setFeatureEnabled(false);
      } finally {
        if (mounted) {
          setFeatureReady(true);
        }
      }
    };

    void run();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    setAvatarLoadFailed(false);
  }, [resolvedAssistantAvatarUrl]);

  useEffect(() => {
    const restored = restoreAiChatConversationsWithSettings(loadStoredChatState(), assistantName, welcomeMessage);
    const storedSize = loadStoredWindowSize();

    setConversations(restored.conversations);
    setActiveConversationId(restored.activeConversationId);

    if (storedSize) {
      setWindowSize(storedSize);
    }

    setCookiesHydrated(true);
  }, []);

  useEffect(() => {
    setConversations((current) => syncAiChatConversationAssistantName(current, assistantName, welcomeMessage));
  }, [assistantName, welcomeMessage]);

  useEffect(() => {
    if (!cookiesHydrated) {
      return;
    }

    persistChatState(conversations, activeConversationId);
  }, [activeConversationId, conversations, cookiesHydrated]);

  useEffect(() => {
    if (!cookiesHydrated) {
      return;
    }

    persistWindowSize(windowSize);
  }, [cookiesHydrated, windowSize]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 720px)");
    const syncViewport = () => {
      setIsCompactViewport(mediaQuery.matches);
    };

    syncViewport();
    mediaQuery.addEventListener("change", syncViewport);

    return () => {
      mediaQuery.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    if (!isOpen || historyOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      if (!list) {
        return;
      }

      list.scrollTo({
        top: list.scrollHeight,
        behavior: "smooth",
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeConversation?.messages, historyOpen, isOpen]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (activeConversation) {
      return;
    }

    const nextConversation = createEmptyConversation(assistantName, welcomeMessage);
    setConversations([nextConversation]);
    setActiveConversationId(nextConversation.id);
  }, [activeConversation, assistantName, welcomeMessage]);

  const handleNewChat = () => {
    const conversation = createEmptyConversation(assistantName, welcomeMessage);

    setConversations((current) => [...current, conversation]);
    setActiveConversationId(conversation.id);
    setHistoryOpen(false);
    setDraft("");
    setPendingAttachments([]);
    setError(null);
    setIsOpen(true);
  };

  const handleDeleteConversation = (conversationId: string) => {
    const deletedConversationIsActive = conversationId === activeConversationId;
    const nextState = deleteAiChatConversation(
      conversations,
      activeConversationId,
      conversationId,
      assistantName,
      welcomeMessage,
    );

    setConversations(nextState.conversations);
    setActiveConversationId(nextState.activeConversationId);

    if (deletedConversationIsActive) {
      setDraft("");
      setPendingAttachments([]);
      setError(null);
    }
  };

  const handleFileSelection = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) {
      return;
    }

    if (pendingAttachments.length + files.length > MAX_AI_CHAT_IMAGES_PER_MESSAGE) {
      setError(`Attach up to ${MAX_AI_CHAT_IMAGES_PER_MESSAGE} images per message.`);
      return;
    }

    try {
      const nextAttachments = await Promise.all(
        files.map(async (file) => {
          if (!file.type.startsWith("image/")) {
            throw new Error("Only image uploads are supported.");
          }

          if (file.size > MAX_AI_CHAT_IMAGE_BYTES) {
            throw new Error(`Each image must be ${Math.floor(MAX_AI_CHAT_IMAGE_BYTES / 1_000_000)} MB or smaller.`);
          }

          return {
            id: crypto.randomUUID(),
            name: file.name || "image",
            dataUrl: await readImageAsDataUrl(file),
          };
        }),
      );

      setPendingAttachments((current) => [...current, ...nextAttachments]);
      setError(null);
    } catch (fileError) {
      setError(formatApiError(fileError));
    }
  };

  const handleSubmit = async () => {
    if (!activeConversation || isSending) {
      return;
    }

    const trimmedDraft = draft.trim();
    if (!trimmedDraft && pendingAttachments.length === 0) {
      return;
    }

    const userMessage = createUserMessage(trimmedDraft, pendingAttachments);
    const nextMessages = [...activeConversation.messages, userMessage];
    const nextTitle = deriveConversationTitle(nextMessages);

    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === activeConversation.id
          ? {
              ...conversation,
              title: nextTitle,
              updatedAt: userMessage.createdAt,
              messages: nextMessages,
            }
          : conversation,
      ),
    );
    setDraft("");
    setPendingAttachments([]);
    setError(null);
    setIsSending(true);
    setHistoryOpen(false);

    try {
      const reply = await sendDocsAiChatMessage(toApiMessages(nextMessages));
      const assistantMessage = createAssistantMessage(reply.text, reply.name ?? assistantName);

      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === activeConversation.id
            ? {
                ...conversation,
                updatedAt: assistantMessage.createdAt,
                messages: [...conversation.messages, assistantMessage],
              }
            : conversation,
        ),
      );
    } catch (sendError) {
      setError(formatApiError(sendError));
    } finally {
      setIsSending(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    void handleSubmit();
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isCompactViewport || !panelRef.current || typeof window === "undefined") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const panelRect = panelRef.current.getBoundingClientRect();
    const startWidth = panelRect.width;
    const startHeight = panelRect.height;
    const startPointerX = event.clientX;
    const startPointerY = event.clientY;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      resizeCleanupRef.current = null;
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startPointerX;
      const deltaY = moveEvent.clientY - startPointerY;
      const nextSize = clampWindowSize({
        width: startWidth - deltaX,
        height: startHeight - deltaY,
      });

      setWindowSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height ? current : nextSize,
      );
    };

    const handlePointerUp = () => {
      cleanup();
    };

    resizeCleanupRef.current = cleanup;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  if (!featureReady || !featureEnabled || !activeConversation) {
    return null;
  }

  const resolvedWindowSize = clampWindowSize(windowSize);
  const panelStyle =
    isCompactViewport
      ? undefined
      : ({
          width: `${resolvedWindowSize.width}px`,
          height: `${resolvedWindowSize.height}px`,
        } as CSSProperties);

  return (
    <>
      {!isOpen ? (
        <button
          type="button"
          className="docs-ai-chat-launch"
          onClick={() => {
            setIsOpen(true);
            setError(null);
          }}
          aria-label="Ask Docs"
        >
          <span className="docs-ai-chat-launch-border" aria-hidden="true" />
          <span className="docs-ai-chat-launch-surface">
            <MaterialIcon name="auto_awesome" />
            <span>Ask Docs</span>
          </span>
        </button>
      ) : null}

      {isOpen ? (
        <section
          ref={panelRef}
          className={cn("docs-ai-chat-panel", isCompactViewport && "docs-ai-chat-panel-compact")}
          style={panelStyle}
          aria-label="Ask Docs chat"
        >
          {!isCompactViewport ? (
            <div
              className="docs-ai-chat-resize-handle"
              onPointerDown={handleResizePointerDown}
              aria-hidden="true"
            />
          ) : null}

          <div className="docs-ai-chat-panel-surface">
            <header className="docs-ai-chat-header">
              <div className="docs-ai-chat-title-group">
                <span
                  className={cn("docs-ai-chat-title-badge", showAssistantAvatar && "docs-ai-chat-title-badge-image")}
                >
                  {showAssistantAvatar ? (
                    <img
                      src={resolvedAssistantAvatarUrl}
                      alt=""
                      className="docs-ai-chat-title-avatar"
                      onError={() => setAvatarLoadFailed(true)}
                    />
                  ) : (
                    <MaterialIcon name="auto_awesome" />
                  )}
                </span>
                <div>
                  <strong>{assistantName}</strong>
                  <p>{resolvedHeaderSubtitle}</p>
                </div>
              </div>

              <div className="docs-ai-chat-header-actions">
                <button
                  type="button"
                  className="docs-ai-chat-icon-button"
                  onClick={() => setHistoryOpen((current) => !current)}
                  aria-label={historyOpen ? "Hide chat history" : "Show chat history"}
                >
                  <MaterialIcon
                    name={historyOpen ? "forum" : "history"}
                    className={cn(historyOpen && "docs-ai-chat-history-back-icon")}
                  />
                </button>
                <button
                  type="button"
                  className="docs-ai-chat-icon-button docs-ai-chat-icon-button-new-chat"
                  onClick={handleNewChat}
                  aria-label="Start a new chat"
                >
                  <MaterialIcon name="add_comment" />
                </button>
                <button
                  type="button"
                  className="docs-ai-chat-icon-button"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close chat"
                >
                  <MaterialIcon name="close" />
                </button>
              </div>
            </header>

            {historyOpen ? (
              <div className="docs-ai-chat-history" aria-label="Saved conversations">
                {conversations
                  .slice()
                  .reverse()
                  .map((conversation) => (
                    <div
                      key={conversation.id}
                      className={cn(
                        "docs-ai-chat-history-item",
                        conversation.id === activeConversation.id && "docs-ai-chat-history-item-active",
                      )}
                    >
                      <button
                        type="button"
                        className="docs-ai-chat-history-select"
                        onClick={() => {
                          setActiveConversationId(conversation.id);
                          setHistoryOpen(false);
                        }}
                      >
                        <strong>{conversation.title}</strong>
                        <span>{formatUpdatedAt(conversation.updatedAt)}</span>
                      </button>
                      <button
                        type="button"
                        className="docs-ai-chat-history-delete"
                        onClick={() => handleDeleteConversation(conversation.id)}
                        aria-label={`Delete conversation ${conversation.title}`}
                        title="Delete conversation"
                        disabled={isSending && conversation.id === activeConversation.id}
                      >
                        <MaterialIcon name="delete" />
                      </button>
                    </div>
                  ))}
              </div>
            ) : (
              <div ref={messageListRef} className="docs-ai-chat-messages" aria-live="polite">
                {activeConversation.messages.map((message) => (
                  <article
                    key={message.id}
                    className={cn(
                      "docs-ai-chat-message",
                      message.role === "assistant" ? "docs-ai-chat-message-assistant" : "docs-ai-chat-message-user",
                    )}
                  >
                    <div className="docs-ai-chat-message-meta">
                      <span>{message.role === "assistant" ? message.name ?? assistantName : "You"}</span>
                    </div>
                    <div className="docs-ai-chat-bubble">
                      {message.text ? (
                        <div className="docs-ai-chat-markdown">
                          <MarkdownRenderer content={message.text} />
                        </div>
                      ) : null}

                      {message.attachments.length > 0 ? (
                        <div className="docs-ai-chat-image-grid">
                          {message.attachments.map((attachment) => (
                            <figure key={attachment.id} className="docs-ai-chat-image-card">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={attachment.dataUrl} alt={attachment.name} />
                              <figcaption>{attachment.name}</figcaption>
                            </figure>
                          ))}
                        </div>
                      ) : null}

                      {message.attachments.length === 0 && message.attachmentNames.length > 0 ? (
                        <div className="docs-ai-chat-attachment-note">
                          {message.attachmentNames.map((name) => (
                            <span key={`${message.id}-${name}`}>{name}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </article>
                ))}

                {isSending ? (
                  <div className="docs-ai-chat-typing" role="status" aria-live="polite">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : null}
              </div>
            )}

            <div className="docs-ai-chat-composer">
              {error ? <p className="error-text docs-ai-chat-error">{error}</p> : null}

              {pendingAttachments.length > 0 ? (
                <div className="docs-ai-chat-pending-attachments">
                  {pendingAttachments.map((attachment) => (
                    <div key={attachment.id} className="docs-ai-chat-pending-card">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={attachment.dataUrl} alt={attachment.name} />
                      <div>
                        <strong>{attachment.name}</strong>
                      </div>
                      <button
                        type="button"
                        className="docs-ai-chat-remove-attachment"
                        onClick={() =>
                          setPendingAttachments((current) => current.filter((item) => item.id !== attachment.id))
                        }
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <MaterialIcon name="close" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <label className="docs-ai-chat-composer-shell" htmlFor="docs-ai-chat-input">
                <textarea
                  id="docs-ai-chat-input"
                  className="docs-ai-chat-input"
                  rows={3}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={`Ask ${assistantName} about these docs...`}
                />
              </label>

              <div className="docs-ai-chat-composer-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  className="docs-ai-chat-file-input"
                  onChange={handleFileSelection}
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSending || pendingAttachments.length >= MAX_AI_CHAT_IMAGES_PER_MESSAGE}
                >
                  <MaterialIcon name="image" />
                  <span>Add Image</span>
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleSubmit()}
                  disabled={isSending}
                >
                  <MaterialIcon name={isSending ? "hourglass_top" : "send"} />
                  <span>{isSending ? "Sending..." : "Send"}</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}
