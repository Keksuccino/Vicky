"use client";

import { clampNumber, formatByteSize, formatChartCoordinate, formatCount, formatStatusTimestamp, formatUsagePercent } from "@/components/admin-settings/format";
import { usePerformanceStatsContext } from "@/components/admin-settings/panel-context";
import { CardRefreshButton } from "@/components/admin-settings/panel-ui";

type PerformanceMetricKind = "memory" | "cpu" | "drive";
type PerformanceUsageTone = "low" | "medium" | "high";

type PerformanceMetricCardProps = {
  detail: string;
  kind: PerformanceMetricKind;
  label: string;
  usagePercent: number;
};

const PERFORMANCE_CHART_WIDTH = 240;
const PERFORMANCE_CHART_HEIGHT = 84;
const PERFORMANCE_CHART_PADDING_X = 5;
const PERFORMANCE_CHART_PADDING_Y = 8;

const getPerformanceUsageTone = (usagePercent: number): PerformanceUsageTone => {
  if (usagePercent < 30) {
    return "low";
  }

  if (usagePercent < 65) {
    return "medium";
  }

  return "high";
};

const createPerformanceMeterGeometry = (usagePercent: number) => {
  const normalizedPercent = clampNumber(usagePercent, 0, 100);
  const baselineY = PERFORMANCE_CHART_HEIGHT - PERFORMANCE_CHART_PADDING_Y;
  const chartHeight = PERFORMANCE_CHART_HEIGHT - PERFORMANCE_CHART_PADDING_Y * 2;
  const startX = PERFORMANCE_CHART_PADDING_X;
  const endX = PERFORMANCE_CHART_WIDTH - PERFORMANCE_CHART_PADDING_X;
  const y = baselineY - (normalizedPercent / 100) * chartHeight;
  const linePath = `M ${formatChartCoordinate(startX)} ${formatChartCoordinate(
    y,
  )} L ${formatChartCoordinate(endX)} ${formatChartCoordinate(y)}`;
  const areaPath = [
    "M",
    formatChartCoordinate(startX),
    formatChartCoordinate(baselineY),
    "L",
    formatChartCoordinate(startX),
    formatChartCoordinate(y),
    "L",
    formatChartCoordinate(endX),
    formatChartCoordinate(y),
    "L",
    formatChartCoordinate(endX),
    formatChartCoordinate(baselineY),
    "Z",
  ].join(" ");

  return {
    areaPath,
    baselineY,
    endX,
    linePath,
    y,
  };
};

function PerformanceMetricCard({ detail, kind, label, usagePercent }: PerformanceMetricCardProps) {
  const percent = clampNumber(usagePercent, 0, 100);
  const percentLabel = formatUsagePercent(percent);
  const usageTone = getPerformanceUsageTone(percent);
  const geometry = createPerformanceMeterGeometry(percent);
  const tickLines = [25, 50, 75].map((tick) => {
    const chartHeight = PERFORMANCE_CHART_HEIGHT - PERFORMANCE_CHART_PADDING_Y * 2;
    const y = geometry.baselineY - (tick / 100) * chartHeight;

    return {
      key: tick,
      y,
    };
  });

  return (
    <div
      className={`visitor-sparkline-card performance-meter-card performance-meter-card-${kind} performance-meter-card-${usageTone}`}
    >
      <div className="visitor-sparkline-meta">
        <strong>{percentLabel}</strong>
        <span>{label}</span>
      </div>
      <span className="visitor-sparkline-range">{detail}</span>
      <div className="performance-meter-stage">
        <svg
          className="performance-meter"
          role="img"
          aria-label={`${label}: ${percentLabel} used. ${detail}.`}
          preserveAspectRatio="none"
          viewBox={`0 0 ${PERFORMANCE_CHART_WIDTH} ${PERFORMANCE_CHART_HEIGHT}`}
        >
          {tickLines.map((tick) => (
            <line
              key={tick.key}
              className="performance-meter-grid-line"
              x1={PERFORMANCE_CHART_PADDING_X}
              x2={PERFORMANCE_CHART_WIDTH - PERFORMANCE_CHART_PADDING_X}
              y1={tick.y}
              y2={tick.y}
            />
          ))}
          <path className="visitor-sparkline-area performance-meter-area" d={geometry.areaPath} />
          <path className="visitor-sparkline-glow performance-meter-glow" d={geometry.linePath} />
          <path className="visitor-sparkline-line performance-meter-line" d={geometry.linePath} />
        </svg>
      </div>
    </div>
  );
}

export function PerformanceStatsCard() {
  const { error, loading, refreshPerformanceStats, stats } = usePerformanceStatsContext();
  const memoryDetail = stats
    ? `${formatByteSize(stats.memory.usedBytes)} of ${formatByteSize(stats.memory.totalBytes)}`
    : "";
  const cpuDetail = stats
    ? `Across ${formatCount(stats.cpu.logicalCores)} logical core${stats.cpu.logicalCores === 1 ? "" : "s"}`
    : "";
  const driveDetail = stats
    ? `${formatByteSize(stats.drive.usedBytes)} of ${formatByteSize(stats.drive.totalBytes)}`
    : "";

  return (
    <section className="panel-card panel-card-performance">
      <div className="panel-header">
        <div>
          <h2>Performance Overview</h2>
          <p className="panel-description">Live server resource usage.</p>
        </div>
        <CardRefreshButton
          disabled={loading}
          label="Refresh performance"
          loading={loading}
          loadingLabel="Refreshing performance"
          onClick={() => {
            void refreshPerformanceStats();
          }}
        />
      </div>

      {error ? <p className="error-text">{error}</p> : null}

      <div className="performance-stats-scroll">
        {!stats ? (
          <p className="muted-caption">{loading ? "Loading performance..." : "No performance data available."}</p>
        ) : (
          <>
            <div className="visitor-section-heading performance-section-heading">
              <span>{loading ? "Refreshing..." : `Updated ${formatStatusTimestamp(stats.updatedAt)}`}</span>
            </div>
            <div className="visitor-sparkline-grid performance-meter-grid">
              <PerformanceMetricCard
                detail={memoryDetail}
                kind="memory"
                label="Memory Usage"
                usagePercent={stats.memory.usagePercent}
              />
              <PerformanceMetricCard
                detail={cpuDetail}
                kind="cpu"
                label="CPU Usage"
                usagePercent={stats.cpu.usagePercent}
              />
              <PerformanceMetricCard
                detail={driveDetail}
                kind="drive"
                label="Drive Usage"
                usagePercent={stats.drive.usagePercent}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
