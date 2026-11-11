"use client";

import { useCallback, useState } from "react";

import { formatStatusTimestamp } from "@/components/admin-settings/format";
import { useAdminPanel, usePanelLoad } from "@/components/admin-settings/panel-context";
import { createAdminModerator, deleteAdminModerator, formatApiError, updateAdminModerator } from "@/components/api";
import { MaterialIcon } from "@/components/material-icon";
import type { ModeratorAccount } from "@/components/types";

type PasswordInputProps = {
  id: string;
  placeholder?: string;
  required?: boolean;
  value: string;
  /** Shows the password as plain text. */
  visible: boolean;
  onChange: (value: string) => void;
  onToggleVisible: () => void;
};

function PasswordInput({ id, placeholder, required, value, visible, onChange, onToggleVisible }: PasswordInputProps) {
  return (
    <div className="password-input-row">
      <input
        id={id}
        className="input"
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="new-password"
        placeholder={placeholder}
        required={required}
      />
      <button
        type="button"
        className="btn btn-icon password-toggle-button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onClick={onToggleVisible}
      >
        <MaterialIcon name={visible ? "visibility_off" : "visibility"} />
      </button>
    </div>
  );
}

/** Sorts a freshly built list in place, as the list shows moderators by username. */
const sortByUsername = (moderators: ModeratorAccount[]): ModeratorAccount[] => moderators.sort((left, right) => left.username.localeCompare(right.username));

export function ModeratorsCard() {
  const { lifetimeSignal } = useAdminPanel();
  const { initialModerators } = usePanelLoad();
  const [moderators, setModerators] = useState<ModeratorAccount[]>(initialModerators);
  const [moderatorUsername, setModeratorUsername] = useState("");
  const [moderatorPassword, setModeratorPassword] = useState("");
  const [showModeratorPassword, setShowModeratorPassword] = useState(false);
  const [moderatorError, setModeratorError] = useState<string | null>(null);
  const [moderatorSaving, setModeratorSaving] = useState(false);
  /** The moderator whose save or removal is in flight; every row's actions wait for it. */
  const [moderatorActionId, setModeratorActionId] = useState<string | null>(null);
  const [editingModeratorId, setEditingModeratorId] = useState<string | null>(null);
  const [editingModeratorUsername, setEditingModeratorUsername] = useState("");
  const [editingModeratorPassword, setEditingModeratorPassword] = useState("");
  const [showEditingModeratorPassword, setShowEditingModeratorPassword] = useState(false);

  const resetModeratorEditor = useCallback(() => {
    setEditingModeratorId(null);
    setEditingModeratorUsername("");
    setEditingModeratorPassword("");
    setShowEditingModeratorPassword(false);
  }, []);

  const handleCreateModerator = useCallback(async () => {
    const signal = lifetimeSignal();
    setModeratorSaving(true);
    setModeratorError(null);

    try {
      const created = await createAdminModerator({
        username: moderatorUsername,
        password: moderatorPassword,
      });
      if (signal.aborted) {
        return;
      }
      setModerators((prev) => sortByUsername([...prev, created]));
      setModeratorUsername("");
      setModeratorPassword("");
      setShowModeratorPassword(false);
    } catch (error) {
      if (!signal.aborted) {
        setModeratorError(formatApiError(error));
      }
    } finally {
      if (!signal.aborted) {
        setModeratorSaving(false);
      }
    }
  }, [lifetimeSignal, moderatorPassword, moderatorUsername]);

  const handleUpdateModerator = useCallback(
    async (account: ModeratorAccount) => {
      const username = editingModeratorUsername.trim();
      if (!username) {
        setModeratorError("Moderator username is required.");
        return;
      }

      const payload: { username?: string; password?: string } = {};
      if (username !== account.username) {
        payload.username = username;
      }

      if (editingModeratorPassword) {
        payload.password = editingModeratorPassword;
      }

      if (!payload.username && !payload.password) {
        resetModeratorEditor();
        return;
      }

      const signal = lifetimeSignal();
      setModeratorActionId(account.id);
      setModeratorError(null);

      try {
        const updated = await updateAdminModerator(account.id, payload);
        if (signal.aborted) {
          return;
        }
        setModerators((prev) => sortByUsername(prev.map((moderator) => (moderator.id === account.id ? updated : moderator))));
        resetModeratorEditor();
      } catch (error) {
        if (!signal.aborted) {
          setModeratorError(formatApiError(error));
        }
      } finally {
        if (!signal.aborted) {
          setModeratorActionId(null);
        }
      }
    },
    [editingModeratorPassword, editingModeratorUsername, lifetimeSignal, resetModeratorEditor],
  );

  const handleDeleteModerator = useCallback(
    async (account: ModeratorAccount) => {
      const signal = lifetimeSignal();
      setModeratorActionId(account.id);
      setModeratorError(null);

      try {
        await deleteAdminModerator(account.id);
        if (signal.aborted) {
          return;
        }
        setModerators((prev) => prev.filter((moderator) => moderator.id !== account.id));
        if (editingModeratorId === account.id) {
          resetModeratorEditor();
        }
      } catch (error) {
        if (!signal.aborted) {
          setModeratorError(formatApiError(error));
        }
      } finally {
        if (!signal.aborted) {
          setModeratorActionId(null);
        }
      }
    },
    [editingModeratorId, lifetimeSignal, resetModeratorEditor],
  );

  return (
    <section className="panel-card panel-card-moderators">
      <div className="panel-header">
        <h2>Moderator Accounts</h2>
      </div>

      <p className="panel-description">
        Create Moderator accounts. Moderators only have access to the editor, not the admin panel.
      </p>

      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreateModerator();
        }}
      >
        <div className="settings-subcard">
          <div className="settings-subcard-fields">
            <div className="field-inline">
              <label className="field-row" htmlFor="moderator-username">
                <span className="field-label">Username</span>
                <input
                  id="moderator-username"
                  className="input"
                  value={moderatorUsername}
                  onChange={(event) => setModeratorUsername(event.target.value)}
                  placeholder="docs-editor"
                  autoComplete="off"
                  required
                />
              </label>

              <div className="field-row">
                <label className="field-label" htmlFor="moderator-password">
                  Password
                </label>
                <PasswordInput
                  id="moderator-password"
                  required
                  value={moderatorPassword}
                  visible={showModeratorPassword}
                  onChange={setModeratorPassword}
                  onToggleVisible={() => setShowModeratorPassword((current) => !current)}
                />
              </div>
            </div>

            <div className="action-row">
              <button type="submit" className="btn" disabled={moderatorSaving}>
                <MaterialIcon name={moderatorSaving ? "hourglass_top" : "person_add"} />
                <span>{moderatorSaving ? "Adding..." : "Add moderator"}</span>
              </button>
            </div>
          </div>
        </div>
      </form>

      {moderatorError ? <p className="error-text">{moderatorError}</p> : null}

      <div className="moderator-list">
        {moderators.length > 0 ? (
          moderators.map((moderator) => {
            const isEditing = editingModeratorId === moderator.id;
            const isBusy = moderatorActionId === moderator.id;

            return (
              <div className="moderator-item" key={moderator.id}>
                {isEditing ? (
                  <form
                    className="moderator-edit-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleUpdateModerator(moderator);
                    }}
                  >
                    <div className="field-inline">
                      <label className="field-row" htmlFor={`moderator-edit-username-${moderator.id}`}>
                        <span className="field-label">Username</span>
                        <input
                          id={`moderator-edit-username-${moderator.id}`}
                          className="input"
                          value={editingModeratorUsername}
                          onChange={(event) => setEditingModeratorUsername(event.target.value)}
                          autoComplete="off"
                          required
                        />
                      </label>

                      <div className="field-row">
                        <label className="field-label" htmlFor={`moderator-edit-password-${moderator.id}`}>
                          New password
                        </label>
                        <PasswordInput
                          id={`moderator-edit-password-${moderator.id}`}
                          placeholder="Leave blank to keep"
                          value={editingModeratorPassword}
                          visible={showEditingModeratorPassword}
                          onChange={setEditingModeratorPassword}
                          onToggleVisible={() => setShowEditingModeratorPassword((current) => !current)}
                        />
                      </div>
                    </div>

                    <div className="action-row">
                      <button type="submit" className="btn btn-primary" disabled={isBusy}>
                        <MaterialIcon name={isBusy ? "hourglass_top" : "save"} />
                        <span>{isBusy ? "Saving..." : "Save moderator"}</span>
                      </button>
                      <button type="button" className="btn btn-secondary" disabled={isBusy} onClick={resetModeratorEditor}>
                        <MaterialIcon name="close" />
                        <span>Cancel</span>
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="moderator-item-main">
                      <strong>{moderator.username}</strong>
                      <span>Updated {formatStatusTimestamp(moderator.updatedAt)}</span>
                    </div>

                    <div className="moderator-actions">
                      <span className="moderator-action-tooltip ui-tooltip" data-ui-tooltip="Edit">
                        <button
                          type="button"
                          className="btn btn-icon moderator-action-button"
                          aria-label="Edit"
                          disabled={Boolean(moderatorActionId)}
                          onClick={() => {
                            setModeratorError(null);
                            setEditingModeratorId(moderator.id);
                            setEditingModeratorUsername(moderator.username);
                            setEditingModeratorPassword("");
                            setShowEditingModeratorPassword(false);
                          }}
                        >
                          <MaterialIcon name="edit" />
                        </button>
                      </span>
                      <span className="moderator-action-tooltip ui-tooltip" data-ui-tooltip="Remove">
                        <button
                          type="button"
                          className="btn btn-icon danger moderator-action-button"
                          aria-label="Remove"
                          disabled={Boolean(moderatorActionId)}
                          onClick={() => {
                            if (window.confirm(`Remove moderator "${moderator.username}"?`)) {
                              void handleDeleteModerator(moderator);
                            }
                          }}
                        >
                          <MaterialIcon name={isBusy ? "hourglass_top" : "delete"} />
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            );
          })
        ) : (
          <p className="muted-caption">No moderator accounts yet.</p>
        )}
      </div>
    </section>
  );
}
