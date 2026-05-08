"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ApiError, formatApiError, getCurrentUser, login } from "@/components/api";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState, LoadingState } from "@/components/states";
import type { AuthUser } from "@/components/types";

const DEFAULT_ADMIN_NEXT_PATH = "/admin/settings";
const DEFAULT_EDITOR_NEXT_PATH = "/editor";
const ALLOWED_NEXT_PATH_PREFIXES = ["/admin", "/editor"];
const DISALLOWED_NEXT_PATHS = new Set(["/admin/login"]);

const getDefaultNextPath = (user: AuthUser | null): string =>
  user?.role === "admin" ? DEFAULT_ADMIN_NEXT_PATH : DEFAULT_EDITOR_NEXT_PATH;

const isAllowedNextPathname = (pathname: string, user: AuthUser | null): boolean => {
  if (DISALLOWED_NEXT_PATHS.has(pathname)) {
    return false;
  }

  if (user?.role === "moderator") {
    return pathname === "/editor" || pathname.startsWith("/editor/");
  }

  return ALLOWED_NEXT_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
};

const getNextPath = (user: AuthUser | null): string => {
  if (typeof window === "undefined") {
    return getDefaultNextPath(user);
  }

  const rawNext = new URLSearchParams(window.location.search).get("next");
  if (!rawNext) {
    return getDefaultNextPath(user);
  }

  try {
    const parsed = new URL(rawNext, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return getDefaultNextPath(user);
    }

    if (!isAllowedNextPathname(parsed.pathname, user)) {
      return getDefaultNextPath(user);
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return getDefaultNextPath(user);
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const formatBlockDuration = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
};

const extractLoginWarning = (error: unknown): string | null => {
  if (!(error instanceof ApiError)) {
    return null;
  }

  const payload = asRecord(error.payload);

  if (error.status === 401) {
    const rawAttemptsLeft = payload.attemptsLeft;
    if (typeof rawAttemptsLeft === "number" && Number.isFinite(rawAttemptsLeft)) {
      const attemptsLeft = Math.max(0, Math.floor(rawAttemptsLeft));
      if (attemptsLeft > 0) {
        return `${attemptsLeft} login attempt${attemptsLeft === 1 ? "" : "s"} left before temporary block.`;
      }
    }

    return null;
  }

  if (error.status === 429) {
    const rawRetryAfterSeconds = payload.retryAfterSeconds;
    if (typeof rawRetryAfterSeconds === "number" && Number.isFinite(rawRetryAfterSeconds)) {
      const retryAfterSeconds = Math.max(1, Math.floor(rawRetryAfterSeconds));
      return `Too many failed attempts. Try again in about ${formatBlockDuration(retryAfterSeconds)}.`;
    }
  }

  return null;
};

export function AdminLoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    const run = async () => {
      try {
        const user = await getCurrentUser();
        if (isActive && user) {
          router.replace(getNextPath(user));
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
          <h1>Sign in</h1>
          <p>Use the admin account or a moderator account to access the tools available to you.</p>
        </div>

        <form
          className="auth-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            setError(null);
            setWarning(null);

            try {
              const user = await login(username, password);
              router.replace(getNextPath(user));
            } catch (submitError) {
              setError(formatApiError(submitError));
              setWarning(extractLoginWarning(submitError));
            } finally {
              setLoading(false);
            }
          }}
        >
          <label className="field-row" htmlFor="login-username">
            <span className="field-label">Username</span>
            <input
              id="login-username"
              className="input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </label>

          <div className="field-row">
            <label className="field-label" htmlFor="admin-password">
              Password
            </label>
            <div className="password-input-row">
              <input
                id="admin-password"
                className="input"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button
                type="button"
                className="btn btn-icon btn-ghost password-toggle-button"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((current) => !current)}
              >
                <MaterialIcon name={showPassword ? "visibility_off" : "visibility"} />
              </button>
            </div>
          </div>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            <MaterialIcon name={loading ? "hourglass_top" : "login"} />
            <span>{loading ? "Signing in..." : "Sign in"}</span>
          </button>
        </form>

        {error ? <ErrorState title="Sign in failed" message={error} /> : null}
        {warning ? <p className="warning-text">{warning}</p> : null}
      </div>
    </section>
  );
}
