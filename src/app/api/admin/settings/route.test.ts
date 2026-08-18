import { NextRequest } from "next/server";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminRequest: vi.fn(),
  setDocsCacheTtlMs: vi.fn(),
  transitionGitHubRuntimeCaches: vi.fn(),
  updateStore: vi.fn(),
}));

vi.mock("@/lib/active-auth", () => ({ requireAdminRequest: mocks.requireAdminRequest }));
vi.mock("@/lib/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cache")>()),
  setDocsCacheTtlMs: mocks.setDocsCacheTtlMs,
}));
vi.mock("@/lib/github-cache-invalidation", () => ({
  transitionGitHubRuntimeCaches: mocks.transitionGitHubRuntimeCaches,
}));
vi.mock("@/lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/store")>()),
  getStore: vi.fn(),
  updateStore: mocks.updateStore,
}));

import { DEFAULT_STORE } from "@/lib/defaults";
import { decryptSecret, encryptSecret } from "@/lib/encryption";
import type { DocsStore } from "@/lib/types";

import { PATCH } from "./route";

const patchRequest = (body: unknown): NextRequest =>
  new NextRequest("http://localhost/api/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const createStore = (): DocsStore => {
  const store = DEFAULT_STORE();
  store.settings.github = {
    owner: "owner",
    repo: "private-docs",
    branch: "main",
    docsPath: "docs",
    tokenEncrypted: encryptSecret("old-token"),
    cacheEpoch: "old-epoch",
  };
  return store;
};

describe("admin settings GitHub cache transition", () => {
  let store: DocsStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
    mocks.requireAdminRequest.mockResolvedValue(null);
    mocks.transitionGitHubRuntimeCaches.mockResolvedValue({
      renderedEntries: 0,
      snapshotEntries: 0,
      translationEntries: 0,
    });
    mocks.updateStore.mockImplementation(async (mutator: (store: DocsStore) => Promise<void>) => {
      const next = structuredClone(store);
      await mutator(next);
      store = next;
      return structuredClone(next);
    });
  });

  it("rotates the security epoch and revokes caches after a successful token rotation", async () => {
    const response = await PATCH(patchRequest({ github: { token: "new-token" } }));

    expect(response.status).toBe(200);
    const body = await response.json() as { settings: { github: Record<string, unknown> } };
    expect(body.settings.github.cacheEpoch).toBeUndefined();
    expect(decryptSecret(store.settings.github.tokenEncrypted)).toBe("new-token");
    expect(store.settings.github.cacheEpoch).not.toBe("old-epoch");
    expect(mocks.transitionGitHubRuntimeCaches).toHaveBeenCalledWith(
      expect.objectContaining({ token: "old-token", cacheEpoch: "old-epoch" }),
      expect.objectContaining({ token: "new-token", cacheEpoch: store.settings.github.cacheEpoch }),
    );
  });

  it("uses the same transition for owner, repo, branch, and docs-path changes", async () => {
    const response = await PATCH(patchRequest({
      github: { owner: "next-owner", repo: "next-repo", branch: "stable", docsPath: "manual" },
    }));

    expect(response.status).toBe(200);
    expect(mocks.transitionGitHubRuntimeCaches).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "owner", repo: "private-docs", branch: "main", docsPath: "docs" }),
      expect.objectContaining({ owner: "next-owner", repo: "next-repo", branch: "stable", docsPath: "manual" }),
    );
  });

  it("does not revoke caches when settings persistence fails", async () => {
    mocks.updateStore.mockImplementationOnce(async (mutator: (store: DocsStore) => Promise<void>) => {
      const next = structuredClone(store);
      await mutator(next);
      throw new Error("disk write failed");
    });

    const response = await PATCH(patchRequest({ github: { token: "new-token" } }));

    expect(response.status).toBe(500);
    expect(mocks.transitionGitHubRuntimeCaches).not.toHaveBeenCalled();
  });
});
