// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startTranslationStatusPolling } from "../translation-status-polling";

describe("translation status polling", () => {
  let visibilityState: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibilityState });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule another poll after the tracked job becomes terminal", async () => {
    let running = true;
    const poll = vi.fn(async () => {
      running = false;
    });
    const stop = startTranslationStatusPolling({ documentTarget: document, intervalMs: 4_000, isJobRunning: () => running, onPoll: poll, windowTarget: window });

    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(poll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("clears polling while hidden and resumes immediately when visible", async () => {
    const poll = vi.fn(async () => undefined);
    const stop = startTranslationStatusPolling({ documentTarget: document, intervalMs: 4_000, isJobRunning: () => true, onPoll: poll, windowTarget: window });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(poll).not.toHaveBeenCalled();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
