"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { MaterialIcon } from "@/components/material-icon";
import { normalizeAccentColor } from "@/lib/theme";

const COLOR_PICKER_SWATCHES = [
  "#006ecf",
  "#15a6e5",
  "#657276",
  "#7db8f0",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#111827",
  "#f8fafc",
];

type PickerHsvColor = {
  h: number;
  s: number;
  v: number;
};

type PickerRgbColor = {
  r: number;
  g: number;
  b: number;
};

export type ColorPickerPlacement = "bottom" | "top";

export type ColorPickerFieldProps = {
  allowEmpty?: boolean;
  emptyLabel?: string;
  fallbackColor?: string;
  hint?: string;
  id: string;
  label: string;
  pickerPlacement?: ColorPickerPlacement;
  resetLabel?: string;
  showReset?: boolean;
  swatches?: string[];
  value: string;
  onChange: (value: string) => void;
};

const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));
const clampHue = (value: number): number => ((value % 360) + 360) % 360;

const rgbToPickerHex = ({ r, g, b }: PickerRgbColor): string =>
  `#${[r, g, b]
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0"))
    .join("")}`;

const pickerHexToRgb = (hex: string): PickerRgbColor => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
});

const pickerHexToHsv = (hex: string): PickerHsvColor => {
  const { r, g, b } = pickerHexToRgb(hex);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;

  if (delta !== 0) {
    if (max === red) {
      hue = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      hue = 60 * ((blue - red) / delta + 2);
    } else {
      hue = 60 * ((red - green) / delta + 4);
    }
  }

  return {
    h: clampHue(hue),
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
};

const pickerHsvToHex = ({ h, s, v }: PickerHsvColor): string => {
  const normalizedHue = clampHue(h);
  const saturation = clampUnit(s);
  const value = clampUnit(v);
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const match = value - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (normalizedHue < 60) {
    red = chroma;
    green = x;
  } else if (normalizedHue < 120) {
    red = x;
    green = chroma;
  } else if (normalizedHue < 180) {
    green = chroma;
    blue = x;
  } else if (normalizedHue < 240) {
    green = x;
    blue = chroma;
  } else if (normalizedHue < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  return rgbToPickerHex({
    r: (red + match) * 255,
    g: (green + match) * 255,
    b: (blue + match) * 255,
  });
};

const sanitizeHexDraft = (value: string): string => `#${value.replace(/[^0-9a-f]/gi, "").slice(0, 6).toUpperCase()}`;
const normalizeCompleteHexDraft = (value: string): string | null => (/^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : null);

export function ColorPickerField({
  allowEmpty = false,
  emptyLabel = "OFF",
  fallbackColor = "#000000",
  hint,
  id,
  label,
  pickerPlacement = "top",
  resetLabel = "Reset",
  showReset = false,
  swatches = COLOR_PICKER_SWATCHES,
  value,
  onChange,
}: ColorPickerFieldProps) {
  const trimmedValue = value.trim();
  const labelId = `${id}-label`;
  const pickerDialogId = `${id}-picker`;
  const normalizedFallbackColor = normalizeAccentColor(fallbackColor, "#000000");
  const normalizedPickerValue = normalizeAccentColor(trimmedValue, normalizedFallbackColor);
  const pickerWrapRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState(normalizedPickerValue.toUpperCase());
  const displayValue = trimmedValue ? trimmedValue.toUpperCase() : emptyLabel;
  const canReset = showReset && normalizedPickerValue !== normalizedFallbackColor;
  const activePickerHex = normalizeCompleteHexDraft(hexDraft) ?? normalizedPickerValue;
  const activePickerHsv = useMemo(() => pickerHexToHsv(activePickerHex), [activePickerHex]);
  const activeHueHex = pickerHsvToHex({ h: activePickerHsv.h, s: 1, v: 1 });
  const previewStyle = trimmedValue
    ? ({
        "--color-picker-preview": trimmedValue,
      } as CSSProperties)
    : undefined;
  const pickerStyle = {
    "--color-picker-hue": activeHueHex,
    "--color-picker-selected": activePickerHex,
    "--color-picker-x": `${activePickerHsv.s * 100}%`,
    "--color-picker-y": `${(1 - activePickerHsv.v) * 100}%`,
  } as CSSProperties;
  const pickerSwatches = useMemo(
    () =>
      Array.from(
        new Set([
          normalizedFallbackColor,
          normalizedPickerValue,
          ...swatches.map((swatch) => normalizeAccentColor(swatch, "")).filter(Boolean),
        ]),
      ),
    [normalizedFallbackColor, normalizedPickerValue, swatches],
  );

  const commitColor = useCallback(
    (nextColor: string) => {
      const normalizedColor = normalizeAccentColor(nextColor, normalizedFallbackColor);

      setHexDraft(normalizedColor.toUpperCase());
      onChange(normalizedColor);
    },
    [normalizedFallbackColor, onChange],
  );

  const handleSpectrumPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      if (event.type === "pointerdown") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }

      const rect = event.currentTarget.getBoundingClientRect();
      const saturation = clampUnit((event.clientX - rect.left) / rect.width);
      const brightness = clampUnit(1 - (event.clientY - rect.top) / rect.height);

      commitColor(
        pickerHsvToHex({
          h: activePickerHsv.h,
          s: saturation,
          v: brightness,
        }),
      );
    },
    [activePickerHsv.h, commitColor],
  );

  const handleSpectrumKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.1 : 0.03;
      let nextSaturation = activePickerHsv.s;
      let nextBrightness = activePickerHsv.v;

      if (event.key === "ArrowLeft") {
        nextSaturation = clampUnit(nextSaturation - step);
      } else if (event.key === "ArrowRight") {
        nextSaturation = clampUnit(nextSaturation + step);
      } else if (event.key === "ArrowDown") {
        nextBrightness = clampUnit(nextBrightness - step);
      } else if (event.key === "ArrowUp") {
        nextBrightness = clampUnit(nextBrightness + step);
      } else {
        return;
      }

      event.preventDefault();
      commitColor(
        pickerHsvToHex({
          h: activePickerHsv.h,
          s: nextSaturation,
          v: nextBrightness,
        }),
      );
    },
    [activePickerHsv, commitColor],
  );

  useEffect(() => {
    setHexDraft(normalizedPickerValue.toUpperCase());
  }, [normalizedPickerValue]);

  useEffect(() => {
    if (!isPickerOpen) {
      return undefined;
    }

    const handleOutsidePointer = (event: MouseEvent | TouchEvent) => {
      const target = event.target;

      if (target instanceof Node && pickerWrapRef.current?.contains(target)) {
        return;
      }

      setIsPickerOpen(false);
    };
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      setIsPickerOpen(false);
      pickerButtonRef.current?.focus();
    };

    document.addEventListener("mousedown", handleOutsidePointer);
    document.addEventListener("touchstart", handleOutsidePointer);
    document.addEventListener("keydown", handleDocumentKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleOutsidePointer);
      document.removeEventListener("touchstart", handleOutsidePointer);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [isPickerOpen]);

  return (
    <div className="field-row">
      <span className="field-label" id={labelId}>
        {label}
      </span>
      <div className="color-picker-field-row">
        <div className="color-picker-wrap" ref={pickerWrapRef}>
          <button
            id={id}
            ref={pickerButtonRef}
            type="button"
            className={`color-picker-trigger${trimmedValue ? "" : " color-picker-trigger-empty"}`}
            style={previewStyle}
            aria-labelledby={labelId}
            aria-haspopup="dialog"
            aria-expanded={isPickerOpen}
            aria-controls={isPickerOpen ? pickerDialogId : undefined}
            onClick={() => setIsPickerOpen((current) => !current)}
          >
            <span className="color-picker-preview" aria-hidden="true" />
            <span className={`color-picker-value${trimmedValue ? "" : " color-picker-value-empty"}`} aria-live="polite">
              {displayValue}
            </span>
            <span className="color-picker-icon" aria-hidden="true">
              <MaterialIcon name="palette" />
            </span>
          </button>
          {isPickerOpen ? (
            <div
              id={pickerDialogId}
              className={`color-picker-popover color-picker-popover-${pickerPlacement}`}
              role="dialog"
              aria-label={`${label} color picker`}
              style={pickerStyle}
            >
              <div
                className="color-picker-spectrum"
                role="slider"
                tabIndex={0}
                aria-label={`${label} saturation and brightness`}
                aria-valuetext={`Saturation ${Math.round(activePickerHsv.s * 100)}%, brightness ${Math.round(activePickerHsv.v * 100)}%`}
                onKeyDown={handleSpectrumKeyDown}
                onPointerDown={handleSpectrumPointer}
                onPointerMove={(event) => {
                  if (event.buttons === 1) {
                    handleSpectrumPointer(event);
                  }
                }}
              >
                <span className="color-picker-spectrum-cursor" aria-hidden="true" />
              </div>
              <label className="color-picker-popover-field">
                <span className="color-picker-popover-label">Hue</span>
                <input
                  className="color-picker-hue-slider"
                  type="range"
                  min="0"
                  max="359"
                  value={Math.round(activePickerHsv.h)}
                  aria-label={`${label} hue`}
                  onChange={(event) =>
                    commitColor(
                      pickerHsvToHex({
                        ...activePickerHsv,
                        h: Number(event.target.value),
                      }),
                    )
                  }
                />
              </label>
              <label className="color-picker-popover-field">
                <span className="color-picker-popover-label">Hex</span>
                <input
                  className="input color-picker-hex-input"
                  value={hexDraft}
                  spellCheck={false}
                  onChange={(event) => {
                    const nextDraft = sanitizeHexDraft(event.target.value);
                    const normalizedColor = normalizeCompleteHexDraft(nextDraft);

                    setHexDraft(nextDraft);

                    if (normalizedColor) {
                      onChange(normalizedColor);
                    }
                  }}
                  onBlur={() => setHexDraft(normalizedPickerValue.toUpperCase())}
                />
              </label>
              <div className="color-picker-swatch-grid" aria-label={`${label} preset colors`}>
                {pickerSwatches.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    className={`color-picker-swatch${swatch === normalizedPickerValue ? " color-picker-swatch-active" : ""}`}
                    style={{ "--color-picker-swatch": swatch } as CSSProperties}
                    aria-label={`Use ${swatch.toUpperCase()}`}
                    onClick={() => commitColor(swatch)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {showReset ? (
          <button
            type="button"
            className="btn color-picker-action"
            disabled={!canReset}
            onClick={() => onChange(normalizedFallbackColor)}
          >
            {resetLabel}
          </button>
        ) : null}
        {allowEmpty ? (
          <button type="button" className="btn color-picker-action" disabled={!trimmedValue} onClick={() => onChange("")}>
            Clear
          </button>
        ) : null}
      </div>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}
