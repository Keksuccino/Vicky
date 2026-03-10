import type { NextRequest } from "next/server";

import { getClientIp } from "@/lib/login-rate-limit";

type AiChatAttemptState = {
  requestedAt: number[];
  blockedUntil: number;
};

export type AiChatRateLimitStatus = {
  blocked: boolean;
  retryAfterSeconds: number;
  remaining: number;
};

const MAX_REQUESTS = 12;
const WINDOW_MS = 60_000;
const BLOCK_MS = 5 * 60_000;

const attemptsByIp = new Map<string, AiChatAttemptState>();

const getRetryAfterSeconds = (blockedUntil: number, now: number): number =>
  Math.max(0, Math.ceil((blockedUntil - now) / 1000));

const pruneEntries = (now: number): void => {
  for (const [key, state] of attemptsByIp.entries()) {
    state.requestedAt = state.requestedAt.filter((requestedAt) => now - requestedAt <= WINDOW_MS);

    if (state.blockedUntil <= now) {
      state.blockedUntil = 0;
    }

    if (state.requestedAt.length === 0 && state.blockedUntil === 0) {
      attemptsByIp.delete(key);
    }
  }
};

export const consumeAiChatRateLimit = (request: NextRequest): AiChatRateLimitStatus => {
  const now = Date.now();
  pruneEntries(now);

  const ip = getClientIp(request);
  const existing = attemptsByIp.get(ip) ?? {
    requestedAt: [],
    blockedUntil: 0,
  };

  if (existing.blockedUntil > now) {
    return {
      blocked: true,
      retryAfterSeconds: getRetryAfterSeconds(existing.blockedUntil, now),
      remaining: 0,
    };
  }

  existing.requestedAt = existing.requestedAt.filter((requestedAt) => now - requestedAt <= WINDOW_MS);

  if (existing.requestedAt.length >= MAX_REQUESTS) {
    existing.blockedUntil = now + BLOCK_MS;
    attemptsByIp.set(ip, existing);
    return {
      blocked: true,
      retryAfterSeconds: getRetryAfterSeconds(existing.blockedUntil, now),
      remaining: 0,
    };
  }

  existing.requestedAt.push(now);
  attemptsByIp.set(ip, existing);

  return {
    blocked: false,
    retryAfterSeconds: 0,
    remaining: Math.max(0, MAX_REQUESTS - existing.requestedAt.length),
  };
};

