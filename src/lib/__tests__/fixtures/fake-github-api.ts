import { createHash } from "node:crypto";

/**
 * In-memory stand-in for the parts of GitHub's REST and GraphQL APIs that Vicky uses, served
 * through `fetch` so tests exercise the real client (timeouts, retries, concurrency cap).
 * Install it with `vi.stubGlobal("fetch", fake.fetch)`.
 */
export type FakeGitHubRequestKind =
  | "blob"
  | "branch"
  | "commit"
  | "contents"
  | "create-blob"
  | "create-commit"
  | "create-tree"
  | "graphql"
  | "other"
  | "put-contents"
  | "ref"
  | "repo"
  | "tree"
  | "update-ref";

export type FakeGitHubRequest = {
  kind: FakeGitHubRequestKind;
  method: string;
  path: string;
  /** For trees: the requested ref or SHA; for blobs: the SHA; for contents: the file path. */
  target: string;
  recursive: boolean;
};

type FakeCommit = {
  author: string;
  date: string;
  paths: Set<string>;
  sha: string;
};

type Interceptor = (request: FakeGitHubRequest) => Promise<Response | undefined> | Response | undefined;

type TreeEntry = { path: string; mode: string; type: "blob" | "tree"; sha: string; size?: number };

const sha1 = (value: string | Uint8Array): string => createHash("sha1").update(value).digest("hex");

const blobSha = (bytes: Buffer): string => createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

export const gitBlobShaOf = (content: string): string => blobSha(Buffer.from(content, "utf8"));

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? Object.assign(new Error("The operation was aborted."), { name: "AbortError" });

export const createFakeGitHub = (options?: { branch?: string; owner?: string; repo?: string }) => {
  const owner = options?.owner ?? "owner";
  const repo = options?.repo ?? "repo";
  const branch = options?.branch ?? "main";
  const files = new Map<string, Buffer>();
  /** Every blob ever written: like GitHub, a blob stays readable by SHA after its file changes. */
  const blobs = new Map<string, Buffer>();
  const commits: FakeCommit[] = [];
  const requests: FakeGitHubRequest[] = [];
  const interceptors: Interceptor[] = [];
  const treeShaPaths = new Map<string, string>();
  /** Trees and commits created through the Git data API; a commit's files apply when the ref moves to it. */
  const stagedTrees = new Map<string, Array<{ path: string; sha: string }>>();
  const stagedCommits = new Map<string, { entries: Array<{ path: string; sha: string }>; commit: FakeCommit }>();
  let clock = Date.parse("2026-01-01T00:00:00Z");
  let inFlight = 0;
  let maxInFlight = 0;
  let latencyMs = 0;
  let truncateRecursiveAbove = Number.POSITIVE_INFINITY;

  const commit = (paths: string[], author = "Writer"): FakeCommit => {
    clock += 60_000;
    const entry: FakeCommit = { author, date: new Date(clock).toISOString().replace(".000Z", "Z"), paths: new Set(paths), sha: sha1(`commit-${commits.length}-${clock}`) };
    commits.push(entry);
    return entry;
  };

  const setFile = (repoPath: string, content: string | Buffer, author?: string): string => {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const sha = blobSha(bytes);
    files.set(repoPath, bytes);
    blobs.set(sha, bytes);
    commit([repoPath], author);
    return sha;
  };

  const deleteFile = (repoPath: string): void => {
    files.delete(repoPath);
    commit([repoPath]);
  };

  /** Lists a directory's direct children, computing deterministic tree SHAs for subdirectories. */
  const listDirectory = (directory: string): TreeEntry[] => {
    const prefix = directory ? `${directory}/` : "";
    const children = new Map<string, TreeEntry>();
    for (const [repoPath, bytes] of files) {
      if (!repoPath.startsWith(prefix)) {
        continue;
      }
      const rest = repoPath.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        children.set(rest, { path: rest, mode: "100644", type: "blob", sha: blobSha(bytes), size: bytes.byteLength });
      } else {
        const name = rest.slice(0, slash);
        if (!children.has(name)) {
          children.set(name, { path: name, mode: "040000", type: "tree", sha: treeSha(`${prefix}${name}`) });
        }
      }
    }
    return Array.from(children.values()).sort((left, right) => left.path.localeCompare(right.path));
  };

  const treeSha = (directory: string): string => {
    const sha = sha1(`tree:${directory}:${listDirectory(directory).map((entry) => `${entry.type}:${entry.path}:${entry.sha}`).join(",")}`);
    treeShaPaths.set(sha, directory);
    return sha;
  };

  const listRecursive = (directory: string, prefix = ""): TreeEntry[] =>
    listDirectory(directory).flatMap((entry) => {
      const listed = { ...entry, path: `${prefix}${entry.path}` };
      return entry.type === "tree" ? [listed, ...listRecursive(directory ? `${directory}/${entry.path}` : entry.path, `${listed.path}/`)] : [listed];
    });

  const historyNode = (repoPath: string) => {
    const latest = [...commits].reverse().find((entry) => entry.paths.has(repoPath));
    return latest ? { author: { name: latest.author, date: latest.date, user: { login: latest.author.toLowerCase() } }, committer: { name: "GitHub", date: latest.date, user: null } } : null;
  };

  const classify = (method: string, url: URL): FakeGitHubRequest => {
    const repoPrefix = `/repos/${owner}/${repo}`;
    const pathname = url.pathname;
    const base = { method, path: `${pathname}${url.search}`, recursive: url.searchParams.get("recursive") === "1" };
    if (pathname === "/graphql") {
      return { ...base, kind: "graphql", target: "" };
    }
    if (pathname.startsWith(`${repoPrefix}/git/trees/`)) {
      return { ...base, kind: "tree", target: decodeURIComponent(pathname.slice(`${repoPrefix}/git/trees/`.length)) };
    }
    if (pathname.startsWith(`${repoPrefix}/git/blobs/`)) {
      return { ...base, kind: "blob", target: pathname.slice(`${repoPrefix}/git/blobs/`.length) };
    }
    if (pathname.startsWith(`${repoPrefix}/contents/`)) {
      return { ...base, kind: method === "PUT" ? "put-contents" : "contents", target: decodeURIComponent(pathname.slice(`${repoPrefix}/contents/`.length)) };
    }
    if (pathname.startsWith(`${repoPrefix}/branches/`)) {
      return { ...base, kind: "branch", target: decodeURIComponent(pathname.slice(`${repoPrefix}/branches/`.length)) };
    }
    if (pathname.startsWith(`${repoPrefix}/git/ref/`)) {
      return { ...base, kind: "ref", target: decodeURIComponent(pathname.slice(`${repoPrefix}/git/ref/`.length)) };
    }
    if (pathname.startsWith(`${repoPrefix}/git/refs/`) && method === "PATCH") {
      return { ...base, kind: "update-ref", target: decodeURIComponent(pathname.slice(`${repoPrefix}/git/refs/`.length)) };
    }
    if (pathname.startsWith(`${repoPrefix}/git/commits/`)) {
      return { ...base, kind: "commit", target: pathname.slice(`${repoPrefix}/git/commits/`.length) };
    }
    if (method === "POST" && pathname === `${repoPrefix}/git/blobs`) {
      return { ...base, kind: "create-blob", target: "" };
    }
    if (method === "POST" && pathname === `${repoPrefix}/git/trees`) {
      return { ...base, kind: "create-tree", target: "" };
    }
    if (method === "POST" && pathname === `${repoPrefix}/git/commits`) {
      return { ...base, kind: "create-commit", target: "" };
    }
    if (pathname === repoPrefix) {
      return { ...base, kind: "repo", target: "" };
    }
    return { ...base, kind: "other", target: "" };
  };

  const respondTree = (request: FakeGitHubRequest, headers: Headers): Response => {
    const directory = request.target === branch ? "" : treeShaPaths.get(request.target);
    if (directory === undefined) {
      return json(404, { message: "Not Found" });
    }

    const sha = treeSha(directory);
    const etag = `"${sha}"`;
    if (headers.get("if-none-match")?.replace(/^W\//, "") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    const entries = request.recursive ? listRecursive(directory) : listDirectory(directory);
    const truncated = request.recursive && entries.length > truncateRecursiveAbove;
    return json(200, { sha, tree: truncated ? entries.slice(0, truncateRecursiveAbove) : entries, truncated }, { etag: `W/${etag}` });
  };

  const respondBlob = (request: FakeGitHubRequest, headers: Headers): Response => {
    const bytes = blobs.get(request.target);
    if (!bytes) {
      return json(404, { message: "Not Found" });
    }
    if (headers.get("accept")?.includes("raw")) {
      return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return json(200, { sha: request.target, size: bytes.byteLength, encoding: "base64", content: bytes.toString("base64") });
  };

  const respondContents = (request: FakeGitHubRequest): Response => {
    const bytes = files.get(request.target);
    if (!bytes) {
      return json(404, { message: "Not Found" });
    }
    // Like GitHub, the contents API omits the content of files over 1 MB.
    const large = bytes.byteLength > 1024 * 1024;
    return json(200, {
      type: "file",
      path: request.target,
      sha: blobSha(bytes),
      size: bytes.byteLength,
      encoding: large ? "none" : "base64",
      content: large ? "" : bytes.toString("base64"),
    });
  };

  const respondPutContents = async (request: FakeGitHubRequest, body: string): Promise<Response> => {
    const payload = JSON.parse(body) as { content: string; sha?: string };
    const current = files.get(request.target);
    if (current && payload.sha !== blobSha(current)) {
      return json(409, { message: `${request.target} does not match ${payload.sha ?? "(none)"}` });
    }
    const sha = setFile(request.target, Buffer.from(payload.content, "base64"), "Editor");
    const latest = commits[commits.length - 1];
    return json(200, {
      content: { path: request.target, sha, size: files.get(request.target)?.byteLength },
      commit: { sha: latest.sha, author: { name: latest.author, date: latest.date }, committer: { name: latest.author, date: latest.date }, tree: { sha: treeSha("") } },
    });
  };

  const respondGraphql = (body: string): Response => {
    const payload = JSON.parse(body) as { variables: Record<string, string> };
    const object: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(payload.variables)) {
      const match = /^path(\d+)$/.exec(name);
      if (match) {
        const node = historyNode(value);
        object[`file${match[1]}`] = { nodes: node ? [node] : [] };
      }
    }
    return json(200, { data: { repository: { object } } });
  };

  const latestCommitSha = (): string => commits[commits.length - 1]?.sha ?? sha1("empty");

  const respondGitData = (request: FakeGitHubRequest, body: string): Response => {
    const payload = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
    switch (request.kind) {
      case "ref":
        return json(200, { ref: `refs/${request.target}`, object: { sha: latestCommitSha(), type: "commit" } });
      case "commit":
        return json(200, { sha: request.target, tree: { sha: treeSha("") } });
      case "create-blob": {
        const bytes = Buffer.from(String(payload.content), payload.encoding === "base64" ? "base64" : "utf8");
        const sha = blobSha(bytes);
        blobs.set(sha, bytes);
        return json(201, { sha });
      }
      case "create-tree": {
        const entries = (payload.tree as Array<{ path: string; sha: string }>).map((entry) => ({ path: entry.path, sha: entry.sha }));
        const sha = sha1(`staged-tree-${stagedTrees.size}-${JSON.stringify(entries)}`);
        stagedTrees.set(sha, entries);
        return json(201, { sha, tree: [] });
      }
      case "create-commit": {
        clock += 60_000;
        const entries = stagedTrees.get(String(payload.tree)) ?? [];
        const created: FakeCommit = { author: "Translator", date: new Date(clock).toISOString().replace(".000Z", "Z"), paths: new Set(entries.map((entry) => entry.path)), sha: sha1(`staged-commit-${stagedCommits.size}-${clock}`) };
        stagedCommits.set(created.sha, { commit: created, entries });
        return json(201, { sha: created.sha, author: { name: created.author, date: created.date }, committer: { name: created.author, date: created.date }, tree: { sha: String(payload.tree) } });
      }
      case "update-ref": {
        const staged = stagedCommits.get(String(payload.sha));
        if (!staged) {
          return json(422, { message: "Object does not exist" });
        }
        for (const entry of staged.entries) {
          const bytes = blobs.get(entry.sha);
          if (bytes) {
            files.set(entry.path, bytes);
          }
        }
        commits.push(staged.commit);
        return json(200, { ref: `refs/${request.target}`, object: { sha: staged.commit.sha, type: "commit" } });
      }
      default:
        return json(404, { message: "Not Found" });
    }
  };

  const respond = async (request: FakeGitHubRequest, headers: Headers, body: string): Promise<Response> => {
    switch (request.kind) {
      case "ref":
      case "commit":
      case "create-blob":
      case "create-tree":
      case "create-commit":
      case "update-ref":
        return respondGitData(request, body);
      case "tree":
        return respondTree(request, headers);
      case "blob":
        return respondBlob(request, headers);
      case "contents":
        return respondContents(request);
      case "put-contents":
        return respondPutContents(request, body);
      case "graphql":
        return respondGraphql(body);
      case "branch":
        return json(200, { name: request.target, commit: { sha: commits[commits.length - 1]?.sha ?? sha1("empty"), commit: { tree: { sha: treeSha("") } } } });
      case "repo":
        return json(200, { default_branch: branch });
      default:
        return json(404, { message: "Not Found" });
    }
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    const request = classify(method, url);
    const signal = init?.signal ?? undefined;
    requests.push(request);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);

    try {
      const work = (async () => {
        for (const interceptor of [...interceptors]) {
          const intercepted = await interceptor(request);
          if (intercepted) {
            return intercepted;
          }
        }
        if (latencyMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, latencyMs));
        }
        return respond(request, headers, body);
      })();

      if (!signal) {
        return await work;
      }
      if (signal.aborted) {
        throw abortReason(signal);
      }
      return await new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    } finally {
      inFlight -= 1;
    }
  };

  return {
    branch,
    commits,
    deleteFile,
    fetch,
    files,
    /** Adds a hook that may answer a request itself; returning `undefined` passes it on. */
    intercept(interceptor: Interceptor): () => void {
      interceptors.push(interceptor);
      return () => {
        const index = interceptors.indexOf(interceptor);
        if (index >= 0) {
          interceptors.splice(index, 1);
        }
      };
    },
    /** Holds every request of `kind` until the returned function is called. */
    hold(kind: FakeGitHubRequestKind): () => void {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const remove = this.intercept(async (request) => {
        if (request.kind === kind) {
          await gate;
        }
        return undefined;
      });
      return () => {
        remove();
        release();
      };
    },
    get maxInFlight(): number {
      return maxInFlight;
    },
    count(kind?: FakeGitHubRequestKind): number {
      return kind ? requests.filter((request) => request.kind === kind).length : requests.length;
    },
    requests,
    resetRequests(): void {
      requests.length = 0;
      maxInFlight = inFlight;
    },
    setFile,
    setLatency(ms: number): void {
      latencyMs = ms;
    },
    truncateRecursiveTreesAbove(entries: number): void {
      truncateRecursiveAbove = entries;
    },
  };
};

export type FakeGitHub = ReturnType<typeof createFakeGitHub>;
