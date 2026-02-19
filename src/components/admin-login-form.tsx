"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { ApiError, formatApiError, getCurrentUser, login } from "@/components/api";
import { MaterialIcon } from "@/components/material-icon";
import { ErrorState, LoadingState } from "@/components/states";

const DEFAULT_NEXT_PATH = "/admin/settings";
const ALLOWED_NEXT_PATH_PREFIXES = ["/admin", "/editor"];
const DISALLOWED_NEXT_PATHS = new Set(["/admin/login"]);

const isAllowedNextPathname = (pathname: string): boolean => {
  if (DISALLOWED_NEXT_PATHS.has(pathname)) {
    return false;
  }

  return ALLOWED_NEXT_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
};

const getNextPath = (): string => {
  if (typeof window === "undefined") {
    return DEFAULT_NEXT_PATH;
  }

  const rawNext = new URLSearchParams(window.location.search).get("next");
  if (!rawNext) {
    return DEFAULT_NEXT_PATH;
  }

  try {
    const parsed = new URL(rawNext, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return DEFAULT_NEXT_PATH;
    }

    if (!isAllowedNextPathname(parsed.pathname)) {
      return DEFAULT_NEXT_PATH;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return DEFAULT_NEXT_PATH;
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
  const [password, setPassword] = useState("");
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
            setWarning(null);

            try {
              await login(password);
              router.replace(getNextPath());
            } catch (submitError) {
              setError(formatApiError(submitError));
              setWarning(extractLoginWarning(submitError));
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
        {warning ? <p className="warning-text">{warning}</p> : null}
      </div>
    </section>
  );
}
