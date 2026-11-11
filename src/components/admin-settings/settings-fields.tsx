type ResetToDefaultButtonProps = {
  disabled: boolean;
  onClick: () => void;
};

export function ResetToDefaultButton({ disabled, onClick }: ResetToDefaultButtonProps) {
  return (
    <button type="button" className="btn field-control-action" disabled={disabled} onClick={onClick}>
      Reset To Default
    </button>
  );
}

type EnabledToggleProps = {
  checked: boolean;
  id: string;
  onChange: (checked: boolean) => void;
};

/** Switch that turns a feature on or off and says which it is. */
export function EnabledToggle({ checked, id, onChange }: EnabledToggleProps) {
  return (
    <label className="toggle-row" htmlFor={id}>
      <input id={id} className="toggle-input" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-control" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span>{checked ? "Enabled" : "Disabled"}</span>
    </label>
  );
}
