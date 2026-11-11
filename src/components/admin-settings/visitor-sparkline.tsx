"use client";

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

import { clampNumber, formatChartCoordinate, formatCount } from "@/components/admin-settings/format";
import type { VisitorStatsPeriod } from "@/components/types";

type VisitorSparklineMetric = "visitors" | "visits";

type VisitorSparklinePoint = {
  key: string;
  label: string;
  period: VisitorStatsPeriod;
  value: number;
  x: number;
  y: number;
};

type VisitorSparklineTooltipPosition = {
  left: number;
  top: number;
};

const VISITOR_SPARKLINE_WIDTH = 240;
const VISITOR_SPARKLINE_HEIGHT = 84;
const VISITOR_SPARKLINE_PADDING_X = 5;
const VISITOR_SPARKLINE_PADDING_Y = 7;
const VISITOR_SPARKLINE_TOOLTIP_GAP = 14;
const VISITOR_SPARKLINE_TOOLTIP_MARGIN_X = 14;
const VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y = 10;

const getVisitorSparklineValue = (period: VisitorStatsPeriod, metric: VisitorSparklineMetric): number =>
  metric === "visitors" ? period.visitors : period.visits;

const formatVisitorTrendRange = (periods: VisitorStatsPeriod[]): string => {
  const first = periods[0];
  const last = periods.at(-1);

  if (!first || !last) {
    return "No activity";
  }

  return first.key === last.key ? first.label : `${first.label} - ${last.label}`;
};

const createVisitorSparklinePoints = (
  periods: VisitorStatsPeriod[],
  metric: VisitorSparklineMetric,
): VisitorSparklinePoint[] => {
  if (periods.length === 0) {
    return [];
  }

  const chartWidth = VISITOR_SPARKLINE_WIDTH - VISITOR_SPARKLINE_PADDING_X * 2;
  const chartHeight = VISITOR_SPARKLINE_HEIGHT - VISITOR_SPARKLINE_PADDING_Y * 2;
  const sourcePeriods = periods.length === 1 ? [periods[0], periods[0]] : periods;
  const sourceValues = periods.map((period) => getVisitorSparklineValue(period, metric));
  const minValue = Math.min(...sourceValues);
  const maxValue = Math.max(...sourceValues);
  const range = maxValue - minValue;

  return sourcePeriods.map((period, index) => {
    const value = getVisitorSparklineValue(period, metric);
    const normalized = range > 0 ? (value - minValue) / range : maxValue > 0 ? 0.56 : 0;
    const x =
      VISITOR_SPARKLINE_PADDING_X +
      (sourcePeriods.length === 1 ? chartWidth : (index / (sourcePeriods.length - 1)) * chartWidth);
    const y = VISITOR_SPARKLINE_HEIGHT - VISITOR_SPARKLINE_PADDING_Y - normalized * chartHeight;

    return {
      key: `${period.key}-${index}`,
      label: period.label,
      period,
      value,
      x,
      y,
    };
  });
};

const createVisitorSparklinePath = (points: VisitorSparklinePoint[]): string => {
  const firstPoint = points[0];
  if (!firstPoint) {
    return "";
  }

  const move = `M ${formatChartCoordinate(firstPoint.x)} ${formatChartCoordinate(firstPoint.y)}`;
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index];
    const controlX = previous.x + (point.x - previous.x) / 2;

    return [
      "C",
      formatChartCoordinate(controlX),
      formatChartCoordinate(previous.y),
      formatChartCoordinate(controlX),
      formatChartCoordinate(point.y),
      formatChartCoordinate(point.x),
      formatChartCoordinate(point.y),
    ].join(" ");
  });

  return [move, ...segments].join(" ");
};

type VisitorSparklineCardProps = {
  label: string;
  metric: VisitorSparklineMetric;
  periods: VisitorStatsPeriod[];
  value: number;
};

export function VisitorSparklineCard({ label, metric, periods, value }: VisitorSparklineCardProps) {
  const chartId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradientId = `visitor-sparkline-fill-${chartId}`;
  const tooltipId = `visitor-sparkline-tooltip-${chartId}`;
  const chartCardRef = useRef<HTMLDivElement>(null);
  const chartStageRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<VisitorSparklineTooltipPosition | null>(null);
  const points = createVisitorSparklinePoints(periods, metric);
  const activePoint = activePointIndex === null ? null : points[activePointIndex] ?? null;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const linePath = createVisitorSparklinePath(points);
  const baselineY = VISITOR_SPARKLINE_HEIGHT - VISITOR_SPARKLINE_PADDING_Y;
  const areaPath =
    firstPoint && lastPoint && linePath
      ? `${linePath} L ${formatChartCoordinate(lastPoint.x)} ${formatChartCoordinate(
          baselineY,
        )} L ${formatChartCoordinate(firstPoint.x)} ${formatChartCoordinate(baselineY)} Z`
      : "";
  const rangeLabel = formatVisitorTrendRange(periods);
  const activePointStyle = activePoint
    ? ({
        "--visitor-active-x": `${(activePoint.x / VISITOR_SPARKLINE_WIDTH) * 100}%`,
        "--visitor-active-y": `${(activePoint.y / VISITOR_SPARKLINE_HEIGHT) * 100}%`,
      } as CSSProperties)
    : undefined;
  const tooltipStyle = activePoint
    ? ({
        left: tooltipPosition ? `${tooltipPosition.left}px` : 0,
        top: tooltipPosition ? `${tooltipPosition.top}px` : 0,
        visibility: tooltipPosition ? "visible" : "hidden",
      } as CSSProperties)
    : undefined;
  const activePointKey = activePoint?.key;
  const activePointX = activePoint?.x;
  const activePointY = activePoint?.y;

  useLayoutEffect(() => {
    if (!activePointKey || activePointX === undefined || activePointY === undefined) {
      return undefined;
    }

    const updateTooltipPosition = () => {
      const chartStage = chartStageRef.current;
      const chartCard = chartCardRef.current;
      const tooltip = tooltipRef.current;

      if (!chartStage || !chartCard || !tooltip) {
        return;
      }

      const stageBounds = chartStage.getBoundingClientRect();
      const cardBounds = chartCard.getBoundingClientRect();
      const tooltipBounds = tooltip.getBoundingClientRect();

      if (
        stageBounds.width <= 0 ||
        stageBounds.height <= 0 ||
        cardBounds.width <= 0 ||
        cardBounds.height <= 0 ||
        tooltipBounds.width <= 0 ||
        tooltipBounds.height <= 0
      ) {
        return;
      }

      const pointX = stageBounds.left - cardBounds.left + (activePointX / VISITOR_SPARKLINE_WIDTH) * stageBounds.width;
      const pointY = stageBounds.top - cardBounds.top + (activePointY / VISITOR_SPARKLINE_HEIGHT) * stageBounds.height;
      const maxLeft = Math.max(
        VISITOR_SPARKLINE_TOOLTIP_MARGIN_X,
        cardBounds.width - tooltipBounds.width - VISITOR_SPARKLINE_TOOLTIP_MARGIN_X,
      );
      const maxTop = Math.max(
        VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y,
        cardBounds.height - tooltipBounds.height - VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y,
      );
      const leftSide = pointX - tooltipBounds.width - VISITOR_SPARKLINE_TOOLTIP_GAP;
      const rightSide = pointX + VISITOR_SPARKLINE_TOOLTIP_GAP;
      const upperSide = pointY - tooltipBounds.height - VISITOR_SPARKLINE_TOOLTIP_GAP;
      const lowerSide = pointY + VISITOR_SPARKLINE_TOOLTIP_GAP;
      const horizontalPreference = pointX <= cardBounds.width / 2 ? "right" : "left";
      const verticalPreference = pointY <= cardBounds.height / 2 ? "lower" : "upper";
      const fallbackHorizontalPreference = horizontalPreference === "right" ? "left" : "right";
      const fallbackVerticalPreference = verticalPreference === "lower" ? "upper" : "lower";
      const candidates = [
        { horizontal: horizontalPreference, vertical: verticalPreference },
        { horizontal: fallbackHorizontalPreference, vertical: verticalPreference },
        { horizontal: horizontalPreference, vertical: fallbackVerticalPreference },
        { horizontal: fallbackHorizontalPreference, vertical: fallbackVerticalPreference },
      ].map((placement) => ({
        left: placement.horizontal === "right" ? rightSide : leftSide,
        top: placement.vertical === "lower" ? lowerSide : upperSide,
      }));
      const selectedPosition =
        candidates.find(
          (candidate) =>
            candidate.left >= VISITOR_SPARKLINE_TOOLTIP_MARGIN_X &&
            candidate.left <= maxLeft &&
            candidate.top >= VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y &&
            candidate.top <= maxTop,
        ) ?? candidates[0];
      const nextPosition = {
        left: Math.round(clampNumber(selectedPosition.left, VISITOR_SPARKLINE_TOOLTIP_MARGIN_X, maxLeft)),
        top: Math.round(clampNumber(selectedPosition.top, VISITOR_SPARKLINE_TOOLTIP_MARGIN_Y, maxTop)),
      };

      setTooltipPosition((currentPosition) =>
        currentPosition?.left === nextPosition.left && currentPosition.top === nextPosition.top
          ? currentPosition
          : nextPosition,
      );
    };

    updateTooltipPosition();

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateTooltipPosition);

    if (resizeObserver && chartCardRef.current && chartStageRef.current && tooltipRef.current) {
      resizeObserver.observe(chartCardRef.current);
      resizeObserver.observe(chartStageRef.current);
      resizeObserver.observe(tooltipRef.current);
    }

    window.addEventListener("resize", updateTooltipPosition);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateTooltipPosition);
    };
  }, [activePointKey, activePointX, activePointY]);

  const activateNearestPoint = (clientX: number) => {
    const chartStage = chartStageRef.current;

    if (!chartStage || points.length === 0) {
      return;
    }

    const bounds = chartStage.getBoundingClientRect();

    if (bounds.width <= 0) {
      return;
    }

    const chartX = ((clientX - bounds.left) / bounds.width) * VISITOR_SPARKLINE_WIDTH;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    points.forEach((point, index) => {
      const distance = Math.abs(point.x - chartX);

      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
    });

    setActivePointIndex((currentIndex) => (currentIndex === nearestIndex ? currentIndex : nearestIndex));
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    activateNearestPoint(event.clientX);
  };

  const handlePointFocus = () => {
    if (points.length === 0) {
      return;
    }

    setActivePointIndex((currentIndex) => currentIndex ?? points.length - 1);
  };

  const handlePointKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (points.length === 0) {
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const direction = event.key === "ArrowRight" ? 1 : -1;

      event.preventDefault();
      setActivePointIndex((currentIndex) => {
        if (currentIndex === null) {
          return direction > 0 ? 0 : points.length - 1;
        }

        return Math.max(0, Math.min(points.length - 1, currentIndex + direction));
      });
    }

    if (event.key === "Escape") {
      setActivePointIndex(null);
    }
  };

  return (
    <div ref={chartCardRef} className={`visitor-sparkline-card visitor-sparkline-card-${metric}`}>
      <div className="visitor-sparkline-meta">
        <strong>{formatCount(value)}</strong>
        <span>{label}</span>
      </div>
      <span className="visitor-sparkline-range">{rangeLabel}</span>
      <div
        ref={chartStageRef}
        className="visitor-sparkline-stage"
        tabIndex={points.length > 0 ? 0 : -1}
        aria-describedby={activePoint ? tooltipId : undefined}
        onBlur={() => setActivePointIndex(null)}
        onFocus={handlePointFocus}
        onKeyDown={handlePointKeyDown}
        onPointerLeave={() => setActivePointIndex(null)}
        onPointerMove={handlePointerMove}
      >
        <svg
          className="visitor-sparkline"
          role="img"
          aria-label={`${label}: ${formatCount(value)}. Trend range: ${rangeLabel}.`}
          preserveAspectRatio="none"
          viewBox={`0 0 ${VISITOR_SPARKLINE_WIDTH} ${VISITOR_SPARKLINE_HEIGHT}`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--visitor-chart-line)" stopOpacity="0.34" />
              <stop offset="100%" stopColor="var(--visitor-chart-line)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {areaPath ? <path className="visitor-sparkline-area" d={areaPath} fill={`url(#${gradientId})`} /> : null}
          {linePath ? (
            <>
              {activePoint ? (
                <line
                  className="visitor-sparkline-guide"
                  x1={activePoint.x}
                  x2={activePoint.x}
                  y1={VISITOR_SPARKLINE_PADDING_Y}
                  y2={baselineY}
                />
              ) : null}
              <path className="visitor-sparkline-glow" d={linePath} />
              <path className="visitor-sparkline-line" d={linePath} />
            </>
          ) : null}
        </svg>
        {activePoint && activePointStyle ? (
          <span className="visitor-sparkline-active-dot" style={activePointStyle} aria-hidden="true" />
        ) : null}
      </div>
      {activePoint ? (
        <div
          ref={tooltipRef}
          id={tooltipId}
          className="visitor-sparkline-tooltip"
          role="tooltip"
          style={tooltipStyle}
        >
          <strong>{activePoint.label}</strong>
          <dl>
            <div>
              <dt>Visitors</dt>
              <dd>{formatCount(activePoint.period.visitors)}</dd>
            </div>
            <div>
              <dt>Visits</dt>
              <dd>{formatCount(activePoint.period.visits)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
