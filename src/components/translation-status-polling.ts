export type TranslationStatusPollingOptions = {
  documentTarget: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  intervalMs: number;
  isJobRunning: () => boolean;
  onPoll: () => Promise<void> | void;
  windowTarget: Pick<Window, "clearTimeout" | "setTimeout">;
};

/**
 * Runs one status request at a time, only while the tracked job is active and the page is visible.
 * Visibility changes clear the pending timer so hidden admin tabs consume no server capacity.
 */
export const startTranslationStatusPolling = ({ documentTarget, intervalMs, isJobRunning, onPoll, windowTarget }: TranslationStatusPollingOptions): (() => void) => {
  let active = true;
  let inFlight = false;
  let timerId: number | null = null;

  const clearTimer = (): void => {
    if (timerId === null) {
      return;
    }

    windowTarget.clearTimeout(timerId);
    timerId = null;
  };

  const canPoll = (): boolean => active && documentTarget.visibilityState !== "hidden" && isJobRunning();

  const schedule = (): void => {
    clearTimer();
    if (!canPoll() || inFlight) {
      return;
    }

    timerId = windowTarget.setTimeout(runPoll, intervalMs);
  };

  const runPoll = (): void => {
    timerId = null;
    if (!canPoll() || inFlight) {
      return;
    }

    inFlight = true;
    void Promise.resolve(onPoll()).catch(() => undefined).finally(() => {
      inFlight = false;
      schedule();
    });
  };

  const handleVisibilityChange = (): void => {
    clearTimer();
    if (canPoll() && !inFlight) {
      runPoll();
    }
  };

  documentTarget.addEventListener("visibilitychange", handleVisibilityChange);
  schedule();

  return () => {
    active = false;
    clearTimer();
    documentTarget.removeEventListener("visibilitychange", handleVisibilityChange);
  };
};
