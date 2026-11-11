import { useCallback, useEffect, useRef } from "react";

import { formatApiError } from "@/components/api";

/**
 * Returns the getter of the panel's lifetime signal, which is aborted when the panel unmounts:
 * every read the panel starts passes this signal, so its requests stop, and every request checks
 * it before updating state, writes included (those run to completion, since the server may
 * already be applying them). Server-side jobs keep running. The settings auto-save tracks the
 * panel's mount itself: it still saves after the unmount (see `settings-auto-save.ts`).
 */
export function usePanelLifetimeSignal(): () => AbortSignal {
  const controllerRef = useRef<AbortController | null>(null);
  const lifetimeSignal = useCallback((): AbortSignal => (controllerRef.current ??= new AbortController()).signal, []);

  useEffect(() => {
    const controller = controllerRef.current ?? new AbortController();
    controllerRef.current = controller;
    return () => {
      controller.abort();
      controllerRef.current = null;
    };
  }, []);

  return lifetimeSignal;
}

type RequestOutcome<T> = { error: null; value: T } | { error: string; value: null };

/**
 * Returns a runner for one kind of read: it settles the read into its value or its formatted
 * error, and resolves to `null` instead when the panel unmounted or a newer read of the same
 * kind started meanwhile, so a slow older answer never replaces a newer one.
 */
export function useNewestRequest(lifetimeSignal: () => AbortSignal) {
  const requestRef = useRef(0);

  return useCallback(
    async <T>(request: (signal: AbortSignal) => Promise<T>): Promise<RequestOutcome<T> | null> => {
      const signal = lifetimeSignal();
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;

      let outcome: RequestOutcome<T>;
      try {
        outcome = { value: await request(signal), error: null };
      } catch (error) {
        outcome = { value: null, error: formatApiError(error) };
      }

      return signal.aborted || requestRef.current !== requestId ? null : outcome;
    },
    [lifetimeSignal],
  );
}
