"use client";

import { useAdminPanel } from "@/components/admin-settings/panel-context";
import { useSettingsSelector, type ClearSecretTarget, type SettingsState } from "@/components/admin-settings/settings-store";

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

const selectSaving = (state: SettingsState): boolean => state.saving;
const selectClearingSecret = (state: SettingsState): ClearSecretTarget | null => state.clearingSecret;

type SecretInputRowProps = {
  /** A secret is typed or saved, so there is something to clear. */
  hasSecret: boolean;
  id: string;
  /** Set when the card validates the field; the input then reports whether it is invalid. */
  invalid?: boolean;
  placeholder: string;
  target: ClearSecretTarget;
  value: string;
  onChange: (value: string) => void;
};

/**
 * Input for a secret the server stores encrypted, with a button that removes the saved secret.
 * A saved secret is never shown: the auto-save clears the field once its value is saved.
 */
export function SecretInputRow({ hasSecret, id, invalid, placeholder, target, value, onChange }: SecretInputRowProps) {
  const { clearSavedSecret } = useAdminPanel();
  const saving = useSettingsSelector(selectSaving);
  const clearingSecret = useSettingsSelector(selectClearingSecret);

  return (
    <div className="secret-input-row">
      <input
        id={id}
        className="input"
        type="text"
        autoComplete="off"
        value={value}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="btn secret-clear-button"
        disabled={saving || clearingSecret !== null || !hasSecret}
        onClick={() => {
          void clearSavedSecret(target);
        }}
      >
        {clearingSecret === target ? "Clearing..." : "Clear"}
      </button>
    </div>
  );
}
