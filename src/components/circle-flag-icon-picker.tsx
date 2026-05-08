"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { CircleFlagIcon } from "@/components/circle-flag-icon";
import { cn } from "@/components/cn";
import { MaterialIcon } from "@/components/material-icon";
import {
  CIRCLE_FLAG_ICON_OPTIONS,
  DEFAULT_CIRCLE_FLAG_ICON_ID,
  getCircleFlagIconOption,
  normalizeCircleFlagIconId,
} from "@/lib/circle-flags";

const MAX_VISIBLE_ICON_OPTIONS = 96;

type CircleFlagIconPickerProps = {
  disabled?: boolean;
  id?: string;
  label?: string;
  onChange: (iconId: string) => void;
  showLabel?: boolean;
  value: string;
};

export function CircleFlagIconPicker({
  disabled = false,
  id,
  label = "Icon",
  onChange,
  showLabel = true,
  value,
}: CircleFlagIconPickerProps) {
  const generatedId = useId();
  const buttonId = id ?? generatedId;
  const searchId = `${buttonId}-search`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selectedIconId = normalizeCircleFlagIconId(value) || DEFAULT_CIRCLE_FLAG_ICON_ID;
  const selectedOption = getCircleFlagIconOption(selectedIconId);
  const selectedLabel = selectedOption?.label ?? selectedIconId;
  const normalizedQuery = query.trim().toLowerCase();

  const visibleOptions = useMemo(() => {
    const matches = normalizedQuery
      ? CIRCLE_FLAG_ICON_OPTIONS.filter((option) => option.search.includes(normalizedQuery))
      : CIRCLE_FLAG_ICON_OPTIONS;

    return matches.slice(0, MAX_VISIBLE_ICON_OPTIONS);
  }, [normalizedQuery]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }

    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [disabled, open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }

    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [open]);

  return (
    <div className="circle-flag-picker" ref={rootRef}>
      <label className="field-row" htmlFor={buttonId}>
        {showLabel ? <span className="field-label">{label}</span> : null}
        <button
          id={buttonId}
          type="button"
          className="btn circle-flag-picker-button"
          aria-label={showLabel ? undefined : `${label}: ${selectedLabel} (${selectedIconId})`}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((previous) => !previous)}
        >
          <CircleFlagIcon iconId={selectedIconId} />
          <span className="circle-flag-picker-value">
            <span>{selectedLabel}</span>
            <code>{selectedIconId}</code>
          </span>
          <MaterialIcon name="arrow_drop_down" />
        </button>
      </label>

      {open ? (
        <div className="circle-flag-picker-popover" role="dialog" aria-label="Pick language icon">
          <div className="search-input-wrap circle-flag-picker-search">
            <MaterialIcon name="search" className="search-icon" />
            <input
              id={searchId}
              ref={searchInputRef}
              className="input"
              value={query}
              aria-label="Search language icons"
              placeholder="Search language or icon ID"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="circle-flag-picker-options">
            {visibleOptions.length > 0 ? (
              visibleOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={cn(
                    "circle-flag-picker-option",
                    option.id === selectedIconId && "circle-flag-picker-option-selected",
                  )}
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <CircleFlagIcon iconId={option.id} />
                  <span>{option.label}</span>
                  <code>{option.id}</code>
                </button>
              ))
            ) : (
              <p className="circle-flag-picker-empty">No icons found</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
