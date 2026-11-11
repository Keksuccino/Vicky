const countFormatter = new Intl.NumberFormat();
const oneDecimalFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

const BYTE_SIZE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export const clampNumber = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export const formatCount = (value: number): string => countFormatter.format(value);

export const formatUsagePercent = (value: number): string => `${oneDecimalFormatter.format(clampNumber(value, 0, 100))}%`;

export const formatByteSize = (value: number): string => {
  let size = Math.max(0, value);
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < BYTE_SIZE_UNITS.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${oneDecimalFormatter.format(size)} ${BYTE_SIZE_UNITS[unitIndex]}`;
};

/** An SVG path coordinate with at most two decimals and no trailing zeros. */
export const formatChartCoordinate = (value: number): string => value.toFixed(2).replace(/\.?0+$/, "");

export const formatStatusTimestamp = (value: string): string => {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }

  return parsed.toLocaleString();
};

const formatRemainingTime = (seconds: number): string => {
  if (seconds < 60) {
    return "less than a minute left";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `about ${minutes} min left`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `about ${hours} h${restMinutes > 0 ? ` ${restMinutes} min` : ""} left`;
};

/** Rounded down, so a bar never reads 100% before the last item is done. */
export const progressPercent = (processed: number, total: number): number => (total > 0 ? Math.min(99, Math.floor((processed / total) * 100)) : 0);

export const formatEtaSeconds = (etaSeconds: number | null): string => (etaSeconds === null ? "working out the time left" : formatRemainingTime(etaSeconds));
