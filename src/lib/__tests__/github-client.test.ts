import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getGitHubClient } from "@/lib/github-client";
import { ApiError } from "@/lib/http";
import type { GitHubRuntimeConfig } from "@/lib/types";

import { createFakeGitHub, gitBlobShaOf, type FakeGitHub } from "./fixtures/fake-github-api";

// Every test uses its own token: rate-limit pauses are remembered per credential.
const createConfig = (): GitHubRuntimeConfig => ({ owner: "owner", repo: "repo", branch: "main", docsPath: "docs", token: `token-${randomUUID()}` });

const getTree = (config: GitHubRuntimeConfig) => getGitHubClient(config).git.getTree({ owner: config.owner, repo: config.repo, tree_sha: config.branch });

describe("shared GitHub client", () => {
  let fake: FakeGitHub;

  beforeEach(() => {
    fake = createFakeGitHub();
    fake.setFile("docs/home.md", "# Home");
    vi.stubGlobal("fetch", fake.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits out retry-after on a 429 and then succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const sentAt: number[] = [];
    let rejected = false;
    fake.intercept((request) => {
      sentAt.push(Date.now());
      if (request.kind === "tree" && !rejected) {
        rejected = true;
        return new Response(JSON.stringify({ message: "Too many requests" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } });
      }
      return undefined;
    });

    const result = getTree(createConfig());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fake.count("tree")).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(result).resolves.toMatchObject({ status: 200 });
    expect(fake.count("tree")).toBe(2);
    expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(7_000);
  });

  it("aborts a stalled request after the timeout and retries it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let stalled = false;
    fake.intercept((request) => {
      if (request.kind === "tree" && !stalled) {
        stalled = true;
        return new Promise<Response>(() => undefined);
      }
      return undefined;
    });

    const result = getTree(createConfig());
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fake.count("tree")).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(result).resolves.toMatchObject({ status: 200 });
    expect(fake.count("tree")).toBe(2);
  });

  it("fails with a 504 once every attempt timed out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    fake.intercept(() => new Promise<Response>(() => undefined));

    const result = getTree(createConfig()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3 * 30_000 + 20_000);

    const error = await result;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 504 });
    expect(fake.count("tree")).toBe(3);
  });

  it("stops sending requests once the quota is used up and reports when it resets", async () => {
    const config = createConfig();
    const resetAtSeconds = Math.ceil(Date.now() / 1000) + 3_600;
    fake.intercept(() =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAtSeconds) },
      }),
    );

    const first = await getTree(config).catch((error: unknown) => error);
    const second = await getTree(config).catch((error: unknown) => error);

    for (const error of [first, second]) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 503 });
      expect(Number(new Headers((error as ApiError).headers).get("retry-after"))).toBeGreaterThan(3_000);
    }
    expect(fake.count()).toBe(1);
  });

  it("does not repeat a write after an ambiguous server error", async () => {
    fake.intercept((request) =>
      request.kind === "put-contents" ? new Response(JSON.stringify({ message: "Bad gateway" }), { status: 502, headers: { "content-type": "application/json" } }) : undefined,
    );
    const config = createConfig();

    await expect(
      getGitHubClient(config).repos.createOrUpdateFileContents({ owner: config.owner, repo: config.repo, path: "docs/home.md", message: "m", content: "eA==" }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fake.count("put-contents")).toBe(1);
  });

  it("paces bulk reads after a burst while interactive requests go straight through", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const config = createConfig();
    const sha = gitBlobShaOf("# Home");
    const blobs = Array.from({ length: 130 }, () =>
      getGitHubClient(config).git.getBlob({ owner: config.owner, repo: config.repo, file_sha: sha, request: { priority: "bulk" } }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.count("blob")).toBe(100);

    const interactive = getTree(config);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.count("tree")).toBe(1);
    await expect(interactive).resolves.toMatchObject({ status: 200 });

    await vi.advanceTimersByTimeAsync(1_000);
    // Ten bulk points per second, one of them taken by the interactive request.
    expect(fake.count("blob")).toBeGreaterThanOrEqual(108);
    expect(fake.count("blob")).toBeLessThanOrEqual(110);

    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all(blobs);
    expect(fake.count("blob")).toBe(130);
  });

  it("spaces bulk writes a second apart after a short burst without delaying an interactive write", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const config = createConfig();
    const sentAt: Array<{ kind: string; at: number }> = [];
    fake.intercept((request) => {
      sentAt.push({ kind: request.kind, at: Date.now() });
      return undefined;
    });
    const trees = Array.from({ length: 9 }, (_, index) =>
      getGitHubClient(config).git.createTree({ owner: config.owner, repo: config.repo, tree: [{ path: `page-${index}.md`, mode: "100644", type: "blob", content: `# Page ${index}` }], request: { idempotent: true, priority: "bulk" } }),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(sentAt.filter((entry) => entry.kind === "create-tree")).toHaveLength(5);
    const save = getGitHubClient(config).repos.createOrUpdateFileContents({ owner: config.owner, repo: config.repo, path: "docs/new.md", message: "m", content: "eA==" });
    await vi.advanceTimersByTimeAsync(1);
    expect(sentAt.filter((entry) => entry.kind === "put-contents")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([...trees, save]);
    const treeTimes = sentAt.filter((entry) => entry.kind === "create-tree").map((entry) => entry.at);
    expect(treeTimes).toHaveLength(9);
    for (let index = 5; index < treeTimes.length; index += 1) {
      expect(treeTimes[index] - treeTimes[index - 1]).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("caps concurrent requests across callers and serves interactive requests before queued bulk ones", async () => {
    fake.setLatency(5);
    const release = fake.hold("blob");
    const config = createConfig();
    const blobs = Array.from({ length: 20 }, () =>
      getGitHubClient(config).git.getBlob({ owner: config.owner, repo: config.repo, file_sha: "a".repeat(40), request: { priority: "bulk" } }).catch(() => undefined),
    );
    await vi.waitFor(() => expect(fake.count("blob")).toBe(8));

    const interactive = getTree(config);
    release();
    await interactive;
    const order = fake.requests.map((request) => request.kind);
    expect(order.indexOf("tree")).toBe(8);
    await Promise.all(blobs);
    expect(fake.maxInFlight).toBe(8);
    expect(fake.count("blob")).toBe(20);
  });
});
