"use client";

import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_GAP = 12;
const VIEWPORT_MARGIN = 12;

type TooltipPlacement = "bottom" | "top";

type TooltipState = {
  text: string;
  trigger: HTMLElement;
};

type TooltipPosition = {
  left: number;
  top: number;
  placement: TooltipPlacement;
};

const getTooltipTrigger = (target: EventTarget | null): HTMLElement | null => {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest<HTMLElement>(".ui-tooltip[data-ui-tooltip]");
};

const getTooltipText = (trigger: HTMLElement): string => trigger.dataset.uiTooltip?.trim() ?? "";

export function UiTooltipLayer() {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const activeTriggerRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const [mounted, setMounted] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const hideTooltip = useCallback(() => {
    activeTriggerRef.current = null;
    mutationObserverRef.current?.disconnect();
    mutationObserverRef.current = null;
    setTooltip(null);
    setPosition(null);
  }, []);

  const updatePosition = useCallback((trigger: HTMLElement) => {
    const text = getTooltipText(trigger);

    if (!text || !document.contains(trigger)) {
      hideTooltip();
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const tooltipElement = tooltipRef.current;
    const tooltipWidth = tooltipElement?.offsetWidth ?? 0;
    const tooltipHeight = tooltipElement?.offsetHeight ?? 0;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const minLeft = tooltipWidth > 0 ? VIEWPORT_MARGIN + tooltipWidth / 2 : VIEWPORT_MARGIN;
    const maxLeft = tooltipWidth > 0 ? viewportWidth - VIEWPORT_MARGIN - tooltipWidth / 2 : viewportWidth - VIEWPORT_MARGIN;
    const idealLeft = rect.left + rect.width / 2;
    const left = Math.max(minLeft, Math.min(maxLeft, idealLeft));
    const hasRoomBelow = rect.bottom + TOOLTIP_GAP + tooltipHeight <= viewportHeight - VIEWPORT_MARGIN;
    const hasRoomAbove = rect.top - TOOLTIP_GAP - tooltipHeight >= VIEWPORT_MARGIN;
    const placement: TooltipPlacement = hasRoomBelow || !hasRoomAbove ? "bottom" : "top";
    const top = placement === "bottom" ? rect.bottom + TOOLTIP_GAP : rect.top - TOOLTIP_GAP;

    setTooltip((current) => (current && current.trigger === trigger && current.text === text ? current : { text, trigger }));
    setPosition({ left, top, placement });
  }, [hideTooltip]);

  const schedulePositionUpdate = useCallback(() => {
    const trigger = activeTriggerRef.current;

    if (!trigger) {
      return;
    }

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updatePosition(trigger);
    });
  }, [updatePosition]);

  const showTooltip = useCallback(
    (trigger: HTMLElement) => {
      const text = getTooltipText(trigger);

      if (!text) {
        hideTooltip();
        return;
      }

      activeTriggerRef.current = trigger;
      setTooltip({ text, trigger });
      updatePosition(trigger);

      mutationObserverRef.current?.disconnect();
      mutationObserverRef.current = new MutationObserver(schedulePositionUpdate);
      mutationObserverRef.current.observe(trigger, {
        attributeFilter: ["data-ui-tooltip"],
        attributes: true,
      });
    },
    [hideTooltip, schedulePositionUpdate, updatePosition],
  );

  useEffect(() => {
    setMounted(true);

    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      mutationObserverRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    const handlePointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        return;
      }

      const trigger = getTooltipTrigger(event.target);

      if (trigger) {
        showTooltip(trigger);
      }
    };
    const handlePointerOut = (event: PointerEvent) => {
      const trigger = activeTriggerRef.current;
      const relatedTarget = event.relatedTarget;

      if (!trigger) {
        return;
      }

      if (relatedTarget instanceof Node && trigger.contains(relatedTarget)) {
        return;
      }

      hideTooltip();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const trigger = getTooltipTrigger(event.target);

      if (trigger) {
        showTooltip(trigger);
      }
    };
    const handleFocusOut = (event: FocusEvent) => {
      const trigger = activeTriggerRef.current;
      const relatedTarget = event.relatedTarget;

      if (!trigger) {
        return;
      }

      if (relatedTarget instanceof Node && trigger.contains(relatedTarget)) {
        return;
      }

      hideTooltip();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hideTooltip();
      }
    };

    document.addEventListener("pointerover", handlePointerOver);
    document.addEventListener("pointerout", handlePointerOut);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    window.addEventListener("resize", schedulePositionUpdate);

    return () => {
      document.removeEventListener("pointerover", handlePointerOver);
      document.removeEventListener("pointerout", handlePointerOut);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
      window.removeEventListener("resize", schedulePositionUpdate);
    };
  }, [hideTooltip, schedulePositionUpdate, showTooltip]);

  useLayoutEffect(() => {
    const trigger = activeTriggerRef.current;

    if (trigger && tooltip) {
      updatePosition(trigger);
    }
  }, [tooltip, updatePosition]);

  if (!mounted || !tooltip || !position) {
    return null;
  }

  return createPortal(
    <div
      ref={tooltipRef}
      className={`ui-tooltip-portal ui-tooltip-portal-${position.placement} ui-tooltip-portal-visible`}
      role="tooltip"
      style={
        {
          "--ui-tooltip-left": `${position.left}px`,
          "--ui-tooltip-top": `${position.top}px`,
        } as CSSProperties
      }
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
