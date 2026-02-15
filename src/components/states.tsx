import { MaterialIcon } from "@/components/material-icon";

type LoadingStateProps = {
  label?: string;
};

type StatusStateProps = {
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
};

export function LoadingState({ label = "Loading content..." }: LoadingStateProps) {
  return (
    <div className="state-card" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p className="state-title">{label}</p>
    </div>
  );
}

export function ErrorState({ title, message, actionLabel, onAction }: StatusStateProps) {
  return (
    <div className="state-card state-error" role="alert">
      <MaterialIcon className="state-icon" name="warning" filled />
      <p className="state-title">{title}</p>
      {message ? <p className="state-message">{message}</p> : null}
      {actionLabel && onAction ? (
        <button type="button" className="btn btn-secondary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, message, actionLabel, onAction }: StatusStateProps) {
  return (
    <div className="state-card" role="status" aria-live="polite">
      <MaterialIcon className="state-icon" name="inbox" />
      <p className="state-title">{title}</p>
      {message ? <p className="state-message">{message}</p> : null}
      {actionLabel && onAction ? (
        <button type="button" className="btn btn-secondary" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
