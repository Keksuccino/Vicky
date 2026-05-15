import { afterEach, describe, expect, it, vi } from "vitest";

import { requestOpenRouterChatCompletion } from "../openrouter";

const request = (timeoutMs: number) =>
  requestOpenRouterChatCompletion({
    apiKey: "openrouter-key",
    messages: [{ role: "user", content: "Translate this." }],
    model: "openai/gpt-5.4-mini",
    origin: "https://docs.example.com",
    siteTitle: "Vicky Docs",
    timeoutMs,
  });

describe("requestOpenRouterChatCompletion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("aborts requests that exceed the configured timeout", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;

        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }),
    );

    const result = request(100);
    const expectation = expect(result).rejects.toMatchObject({
      message: "OpenRouter request timed out after 1 second.",
      status: 504,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expectation;
  });

  it("keeps the timeout active while reading the response body", async () => {
    vi.useFakeTimers();

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return Promise.resolve({
          ok: true,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              });
            }),
        } as Response);
      }),
    );

    const result = request(100);
    const expectation = expect(result).rejects.toMatchObject({
      message: "OpenRouter request timed out after 1 second.",
      status: 504,
    });

    await vi.advanceTimersByTimeAsync(100);

    await expectation;
  });
});
