import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveRuntimeStorageLayout, RUNTIME_TOPOLOGY_ENV, SUPPORTED_RUNTIME_TOPOLOGY } from "@/lib/runtime-topology.mjs";

type Outcome = { type: "acquired" | "rejected"; message?: string; pid: number };
type WorkerMessage = { type: "ready" | "released" } | Outcome;

const CONTENDER_COUNT = 32;
const WORKER_PATH = fileURLToPath(new URL("./fixtures/runtime-owner-contender.mjs", import.meta.url));
const childProcesses: ChildProcess[] = [];
const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-runtime-owner-process-"));
  tempDirs.push(tempDir);
  return tempDir;
};

const waitForMessage = <T extends WorkerMessage>(child: ChildProcess, predicate: (message: WorkerMessage) => message is T, stderr: () => string): Promise<T> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    cleanup();
    reject(new Error(`Runtime owner contender ${String(child.pid)} timed out. ${stderr()}`));
  }, 15_000);
  const onMessage = (message: WorkerMessage) => {
    if (predicate(message)) {
      cleanup();
      resolve(message);
    }
  };
  const onError = (error: Error) => {
    cleanup();
    reject(error);
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    cleanup();
    reject(new Error(`Runtime owner contender exited before responding (code ${String(code)}, signal ${String(signal)}). ${stderr()}`));
  };
  const cleanup = () => {
    clearTimeout(timeout);
    child.removeListener("message", onMessage);
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
  };
  child.on("message", onMessage);
  child.once("error", onError);
  child.once("exit", onExit);
});

const startContender = (runtimeDirectory: string) => {
  let stderr = "";
  const child = fork(WORKER_PATH, [runtimeDirectory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  childProcesses.push(child);
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const stderrText = () => stderr;
  const ready = waitForMessage(child, (message): message is { type: "ready" } => message.type === "ready", stderrText);
  const outcome = waitForMessage(child, (message): message is Outcome => message.type === "acquired" || message.type === "rejected", stderrText);
  return { child, outcome, ready, stderrText };
};

const releaseContender = async (contender: ReturnType<typeof startContender>): Promise<void> => {
  const released = waitForMessage(contender.child, (message): message is { type: "released" } => message.type === "released", contender.stderrText);
  contender.child.send("release");
  await released;
};

const runSynchronizedContention = async (runtimeDirectory: string): Promise<Outcome[]> => {
  const contenders = Array.from({ length: CONTENDER_COUNT }, () => startContender(runtimeDirectory));
  await Promise.all(contenders.map((contender) => contender.ready));
  for (const contender of contenders) {
    contender.child.send("start");
  }

  const outcomes = await Promise.all(contenders.map((contender) => contender.outcome));
  await Promise.all(contenders.filter((_, index) => outcomes[index].type === "acquired").map(releaseContender));
  return outcomes;
};

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("runtime owner multiprocess exclusion", () => {
  it("allows exactly one live owner under 32 synchronized process starts", async () => {
    const cwd = await createTempDir();
    const outcomes = await runSynchronizedContention(cwd);

    expect(outcomes.filter((outcome) => outcome.type === "acquired")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.type === "rejected")).toHaveLength(CONTENDER_COUNT - 1);
  }, 30_000);

  it("never reclaims one dead same-host record under 32 synchronized process starts", async () => {
    const cwd = await createTempDir();
    const environment: NodeJS.ProcessEnv = { NODE_ENV: "test", [RUNTIME_TOPOLOGY_ENV]: SUPPORTED_RUNTIME_TOPOLOGY };
    const { ownerFilePath } = resolveRuntimeStorageLayout(environment, cwd);
    const staleRaw = `${JSON.stringify({ schemaVersion: 1, topology: SUPPORTED_RUNTIME_TOPOLOGY, ownerId: "dead-same-host-owner", hostname: "stress-host", pid: 2147483647, startedAt: "2026-08-18T00:00:00.000Z" }, null, 2)}\n`;
    await mkdir(path.dirname(ownerFilePath), { recursive: true, mode: 0o700 });
    await writeFile(ownerFilePath, staleRaw, { encoding: "utf8", mode: 0o600 });

    const outcomes = await runSynchronizedContention(cwd);

    expect(outcomes.filter((outcome) => outcome.type === "acquired")).toHaveLength(0);
    expect(outcomes.filter((outcome) => outcome.type === "rejected")).toHaveLength(CONTENDER_COUNT);
    expect(await readFile(ownerFilePath, "utf8")).toBe(staleRaw);
    expect(outcomes.every((outcome) => outcome.message?.includes("never automatically reclaims"))).toBe(true);
  }, 30_000);
});
