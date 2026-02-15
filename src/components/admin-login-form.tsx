"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { formatApiError, getCurrentUser, login } from "@/components/api";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState, LoadingState } from "@/components/states";

const getNextPath = (): string => {
  if (typeof window === "undefined") {
    return "/admin/settings";
  }

  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") ? next : "/admin/settings";
};

export function AdminLoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    const run = async () => {
      try {
        const user = await getCurrentUser();
        if (isActive && user) {
          router.replace(getNextPath());
        }
      } catch {
        // Keep login form visible when auth check fails.
      } finally {
        if (isActive) {
          setCheckingAuth(false);
        }
      }
    };

    void run();

    return () => {
      isActive = false;
    };
  }, [router]);

  if (checkingAuth) {
    return <LoadingState label="Checking your session..." />;
  }

  return (
    <section className="auth-page">
      <div className="auth-card">
        <div className="auth-hero">
          <MaterialIcon name="verified_user" className="auth-icon" />
          <h1>Admin sign in</h1>
          <p>Sign in with your admin password to manage repository settings, themes, and pages.</p>
        </div>

        <form
          className="auth-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            setError(null);

            try {
              await login(password);
              router.replace(getNextPath());
            } catch (submitError) {
              setError(formatApiError(submitError));
            } finally {
              setLoading(false);
            }
          }}
        >
          <label className="field-row" htmlFor="admin-password">
            <span className="field-label">Admin password</span>
            <input
              id="admin-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            <MaterialIcon name={loading ? "hourglass_top" : "login"} />
            <span>{loading ? "Signing in..." : "Sign in"}</span>
          </button>
        </form>

        {error ? <ErrorState title="Sign in failed" message={error} /> : null}
      </div>
    </section>
  );
}
