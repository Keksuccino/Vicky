import type { CSSProperties } from "react";

import { MaterialIcon } from "@/components/material-icon";

type ProgressPanelProps = {
  ariaLabel: string;
  detail: string;
  percent: number;
  title: string;
};

/** Progress of a long-running background job: title, percentage, bar, and what is left. */
export function ProgressPanel({ ariaLabel, detail, percent, title }: ProgressPanelProps) {
  const style = { "--progress-panel-size": `${percent}%` } as CSSProperties;

  return (
    <div className="progress-panel">
      <div className="progress-panel-heading">
        <strong>{title}</strong>
        <span>{percent}%</span>
      </div>
      <div className="progress-panel-bar" role="progressbar" aria-label={ariaLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={style} />
      </div>
      <span className="progress-panel-detail">{detail}</span>
    </div>
  );
}

type CardRefreshButtonProps = {
  disabled: boolean;
  /** Tooltip and label while `loading`. */
  loadingLabel: string;
  label: string;
  loading: boolean;
  onClick: () => void;
};

/** Icon button in a card header that loads the card's data again. */
export function CardRefreshButton({ disabled, label, loading, loadingLabel, onClick }: CardRefreshButtonProps) {
  const currentLabel = loading ? loadingLabel : label;

  return (
    <span className="visitor-refresh-tooltip ui-tooltip" data-ui-tooltip={currentLabel}>
      <button type="button" className="btn btn-icon visitor-refresh-button" disabled={disabled} aria-label={currentLabel} onClick={onClick}>
        <MaterialIcon name={loading ? "hourglass_top" : "refresh"} />
      </button>
    </span>
  );
}
