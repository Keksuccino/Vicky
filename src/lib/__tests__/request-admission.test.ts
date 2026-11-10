import { afterEach, describe, expect, it } from "vitest";

import { createAdmissionLimiter, type AdmissionPermit } from "@/lib/request-admission";

const requestFrom = (ip: string) => ({ headers: new Headers(), ip });
const LIMITS = { clientMaxRequests: 1, clientMaxConcurrency: 1, globalMaxRequests: 100_000, globalMaxConcurrency: 100_000, rateWindowMs: 60_000 };

const release = (permit: AdmissionPermit): void => {
  if (permit.allowed) {
    permit.release();
  }
};

const clientIp = (index: number): string => `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;

describe("request admission limiter", () => {
  const limiter = createAdmissionLimiter("test.requestAdmission", LIMITS);

  afterEach(() => {
    limiter.reset();
  });

  it("slides the rate window by the oldest request and reports when the next one is admitted", () => {
    const sliding = createAdmissionLimiter("test.requestAdmission.sliding", { ...LIMITS, clientMaxRequests: 3, clientMaxConcurrency: 10, rateWindowMs: 10_000 });
    const client = requestFrom("203.0.113.5");
    for (const now of [1_000, 4_000, 7_000]) {
      release(sliding.acquire(client, now));
    }

    expect(sliding.acquire(client, 9_000)).toEqual({ allowed: false, retryAfterSeconds: 2 });
    const afterOldest = sliding.acquire(client, 11_000);
    expect(afterOldest.allowed).toBe(true);
    release(afterOldest);
    expect(sliding.acquire(client, 12_000)).toEqual({ allowed: false, retryAfterSeconds: 2 });
    sliding.reset();
  });

  it("evicts the least recently seen idle client at capacity and never one with a request in flight", () => {
    const active = limiter.acquire(requestFrom(clientIp(0)), 1_000);
    expect(active.allowed).toBe(true);
    for (let index = 1; index < 10_000; index += 1) {
      release(limiter.acquire(requestFrom(clientIp(index)), 1_000 + index));
    }

    // A new client at capacity replaces the least recently seen idle client (1), not the active one (0).
    release(limiter.acquire(requestFrom("198.51.100.1"), 12_000));

    // Client 2 is still tracked, so its request of this window still counts.
    expect(limiter.acquire(requestFrom(clientIp(2)), 12_001).allowed).toBe(false);
    // Client 1 was forgotten and starts over.
    const forgotten = limiter.acquire(requestFrom(clientIp(1)), 12_002);
    expect(forgotten.allowed).toBe(true);
    release(forgotten);
    expect(limiter.acquire(requestFrom(clientIp(0)), 12_003)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    release(active);
  });
});
