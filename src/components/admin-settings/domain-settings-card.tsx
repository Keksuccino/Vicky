"use client";

import { formatStatusTimestamp } from "@/components/admin-settings/format";
import { useAdminPanel, useSslStatusContext } from "@/components/admin-settings/panel-context";
import { useDraftFields, useFieldErrors } from "@/components/admin-settings/settings-store";
import { validateCustomDomainInput, validateLetsEncryptEmailInput } from "@/components/admin-settings/settings-validation";
import type { DomainSslRuntimeStatus } from "@/components/types";

const statusToneClassName = (status: DomainSslRuntimeStatus): "success-text" | "warning-text" | "error-text" => {
  if (status.configured && !status.httpsAvailable) {
    return "error-text";
  }

  switch (status.certificateState) {
    case "valid":
      return "success-text";
    case "expiring_soon":
    case "missing":
      return "warning-text";
    case "expired":
    case "domain_mismatch":
    case "invalid":
      return "error-text";
    default:
      return "warning-text";
  }
};

const formatCustomDomainHttpPolicy = (status: DomainSslRuntimeStatus): string => {
  switch (status.customDomainHttpPolicy) {
    case "redirect":
      return "redirect to HTTPS";
    case "maintenance":
      return "fail-closed maintenance response";
    default:
      return "serve application";
  }
};

const DOMAIN_FIELDS = ["customDomain", "letsEncryptEmail"] as const;

export function DomainSettingsCard() {
  const { settingsStore } = useAdminPanel();
  const settings = useDraftFields(DOMAIN_FIELDS);
  const domainFieldErrors = useFieldErrors("domain");
  const { error: sslStatusError, loading: sslStatusLoading, status: sslStatus } = useSslStatusContext();

  return (
    <section className="panel-card panel-card-domain">
      <div className="panel-header">
        <h2>Domain Settings</h2>
      </div>

      <p className="panel-description">
        Configure your custom domain and Let&apos;s Encrypt contact email for automatic HTTPS certificate management.
      </p>

      <div className="form-grid">
        <div className="settings-subcard">
          <div className="settings-subcard-fields">
            <label className="field-row" htmlFor="domain-custom-domain">
              <span className="field-label">Custom domain</span>
              <input
                id="domain-custom-domain"
                className="input"
                value={settings.customDomain}
                aria-invalid={Boolean(domainFieldErrors.customDomain)}
                onChange={(event) => {
                  const value = event.target.value;
                  settingsStore.setDraftField("customDomain", value);
                  settingsStore.patchErrors("domain", { customDomain: validateCustomDomainInput(value) });
                }}
                placeholder="docs.example.com"
              />
              <span className="field-hint">
                Hostname only (no protocol or path). Example: <code>example.com</code> or{" "}
                <code>docs.example.com</code>.
              </span>
              {domainFieldErrors.customDomain ? <span className="error-text">{domainFieldErrors.customDomain}</span> : null}
            </label>

            <label className="field-row" htmlFor="domain-letsencrypt-email">
              <span className="field-label">Let&apos;s Encrypt email</span>
              <input
                id="domain-letsencrypt-email"
                className="input"
                type="email"
                value={settings.letsEncryptEmail}
                aria-invalid={Boolean(domainFieldErrors.letsEncryptEmail)}
                onChange={(event) => {
                  const value = event.target.value;
                  settingsStore.setDraftField("letsEncryptEmail", value);
                  settingsStore.patchErrors("domain", { letsEncryptEmail: validateLetsEncryptEmailInput(value) });
                }}
                placeholder="admin@example.com"
              />
              <span className="field-hint">
                Required for automatic certificate registration and renewal notifications.
              </span>
              {domainFieldErrors.letsEncryptEmail ? (
                <span className="error-text">{domainFieldErrors.letsEncryptEmail}</span>
              ) : null}
            </label>
          </div>
        </div>

        <div className="settings-subcard">
          <div className="settings-subcard-fields">
            <div className="field-row">
              <span className="field-label">SSL runtime status</span>
              {sslStatusLoading ? <span className="field-hint">Checking certificate runtime status...</span> : null}
              {!sslStatusLoading && sslStatus ? (
                <>
                  <p className={statusToneClassName(sslStatus)}>{sslStatus.message}</p>
                  <span className="field-hint">
                    Source:{" "}
                    {sslStatus.source === "runtime"
                      ? "private runtime status snapshot."
                      : "best-effort check (settings + local cert files)."}
                  </span>
                  {sslStatus.certificateExpiresAt ? (
                    <span className="field-hint">
                      Certificate expiry: {formatStatusTimestamp(sslStatus.certificateExpiresAt)}.
                    </span>
                  ) : null}
                  <span className="field-hint">
                    Custom-domain HTTP policy: {formatCustomDomainHttpPolicy(sslStatus)}.
                  </span>
                  <span className="field-hint">Last checked: {formatStatusTimestamp(sslStatus.checkedAt)}.</span>
                </>
              ) : null}
              {sslStatusError ? <p className="warning-text">Could not load SSL runtime status: {sslStatusError}</p> : null}
            </div>

            <p className="warning-text">
              Automatic SSL runs only when both values are set and DNS points this domain to your server.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
