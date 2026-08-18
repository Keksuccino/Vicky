import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireRuntimeOwnerLease,
  resolveRuntimeStorageLayout,
  RUNTIME_OWNER_ID_ENV,
  RUNTIME_TOPOLOGY_ENV,
  shouldReleaseRuntimeOwnerOnProcessExit,
  SUPPORTED_RUNTIME_TOPOLOGY,
  validateRuntimeTopology,
  verifyInheritedRuntimeOwnerLease,
  waitForRuntimeOwnerAssignment,
} from "@/lib/runtime-topology.mjs";

type RuntimeLease = Awaited<ReturnType<typeof acquireRuntimeOwnerLease>>;

const tempDirs: string[] = [];
const leases: RuntimeLease[] = [];
const environmentFor = (topology: string | null = SUPPORTED_RUNTIME_TOPOLOGY): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...(topology === null ? {} : { [RUNTIME_TOPOLOGY_ENV]: topology }) });

const createTempDir = async (): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vicky-runtime-topology-"));
  tempDirs.push(tempDir);
  return tempDir;
};

const writeOwner = async (ownerFilePath: string, owner: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(ownerFilePath), { recursive: true, mode: 0o700 });
  await writeFile(ownerFilePath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
};

const writeAssignment = async (assignmentFilePath: string, assignment: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(assignmentFilePath), { recursive: true, mode: 0o700 });
  await writeFile(assignmentFilePath, `${JSON.stringify(assignment, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
};

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.release().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

describe("runtime topology", () => {
  it("requires the one explicitly supported topology", () => {
    expect(validateRuntimeTopology(environmentFor())).toBe(SUPPORTED_RUNTIME_TOPOLOGY);
    expect(() => validateRuntimeTopology(environmentFor(null))).toThrow(`${RUNTIME_TOPOLOGY_ENV} must be set`);
    expect(() => validateRuntimeTopology(environmentFor("multi-process"))).toThrow("does not provide multi-process or multi-host coordination");
  });

  it("rejects an explicitly empty runtime path before touching its parent", async () => {
    const cwd = await createTempDir();
    expect(() => resolveRuntimeStorageLayout({ ...environmentFor(), WIKI_STORE_FILE_PATH: "" }, cwd)).toThrow("WIKI_STORE_FILE_PATH must not be empty");
  });

  it("rejects any broad directory in the complete layout before creating the owner or data directory", async () => {
    const cwd = await createTempDir();
    const broadDirectory = process.platform === "win32" ? path.dirname(os.homedir()) : process.platform === "darwin" ? "/Users" : "/var/lib";
    const before = await stat(broadDirectory);
    const environment = { ...environmentFor(), WIKI_MARKDOWN_CACHE_DIR: broadDirectory };
    const layout = resolveRuntimeStorageLayout(environment, cwd);

    await expect(acquireRuntimeOwnerLease({ cwd, environment })).rejects.toThrow("shared, system, or root directory");
    const after = await stat(broadDirectory);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(stat(layout.ownerFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(cwd, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the exclusive owner immutable while assigning, verifying, and releasing a child", async () => {
    const cwd = await createTempDir();
    const environment = environmentFor();
    const layout = resolveRuntimeStorageLayout(environment, cwd);
    const lease = await acquireRuntimeOwnerLease({ cwd, environment, hostname: "host-a", pid: 101 });
    leases.push(lease);

    expect(environment[RUNTIME_OWNER_ID_ENV]).toBe(lease.id);
    const immutableOwnerRaw = await readFile(layout.ownerFilePath, "utf8");
    expect(JSON.parse(immutableOwnerRaw)).toMatchObject({ ownerId: lease.id, hostname: "host-a", pid: 101, topology: SUPPORTED_RUNTIME_TOPOLOGY });
    await verifyInheritedRuntimeOwnerLease(environment, cwd, 101);
    await expect(verifyInheritedRuntimeOwnerLease(environment, cwd, 202)).rejects.toThrow("child assignment does not match");

    await lease.assignProcess(202);
    expect(await readFile(layout.ownerFilePath, "utf8")).toBe(immutableOwnerRaw);
    expect(JSON.parse(await readFile(layout.assignmentFilePath, "utf8"))).toMatchObject({ ownerId: lease.id, pid: 202, topology: SUPPORTED_RUNTIME_TOPOLOGY });
    await verifyInheritedRuntimeOwnerLease(environment, cwd, 202);

    await lease.release();
    leases.splice(leases.indexOf(lease), 1);
    await expect(stat(layout.ownerFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(layout.assignmentFilePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights every configured runtime location and repairs existing sensitive files", async () => {
    const cwd = await createTempDir();
    const environment = environmentFor();
    const layout = resolveRuntimeStorageLayout(environment, cwd);
    await mkdir(path.dirname(layout.storePath), { recursive: true, mode: 0o755 });
    await writeFile(layout.storePath, "{}", { encoding: "utf8", mode: 0o644 });
    await chmod(path.dirname(layout.storePath), 0o755);
    await chmod(layout.storePath, 0o644);

    const lease = await acquireRuntimeOwnerLease({ cwd, environment });
    leases.push(lease);
    for (const directoryPath of layout.directories) {
      await expect(stat(directoryPath)).resolves.toMatchObject({});
      expect((await readdir(directoryPath)).some((fileName) => fileName.startsWith(".vicky-runtime-preflight-"))).toBe(false);
    }
    if (process.platform !== "win32") {
      expect((await stat(path.dirname(layout.storePath))).mode & 0o777).toBe(0o700);
      expect((await stat(layout.storePath)).mode & 0o777).toBe(0o600);
      expect((await stat(layout.ownerFilePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the child gate closed until the exclusive child assignment exists", async () => {
    const cwd = await createTempDir();
    const environment = environmentFor();
    const lease = await acquireRuntimeOwnerLease({ cwd, environment, hostname: "host-a", pid: 101 });
    leases.push(lease);
    let gateOpened = false;
    const gate = waitForRuntimeOwnerAssignment(environment, cwd, 202, { pollMs: 1, timeoutMs: 1_000 }).then(() => {
      gateOpened = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateOpened).toBe(false);
    await lease.assignProcess(202);
    await gate;
    expect(gateOpened).toBe(true);
  });

  it("keeps the child gate closed while an exclusively reserved assignment is still being written", async () => {
    const cwd = await createTempDir();
    const environment = environmentFor();
    const layout = resolveRuntimeStorageLayout(environment, cwd);
    const lease = await acquireRuntimeOwnerLease({ cwd, environment, hostname: "host-a", pid: 101 });
    leases.push(lease);
    const ownerRaw = await readFile(layout.ownerFilePath, "utf8");
    await writeFile(layout.assignmentFilePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });

    let gateOpened = false;
    const gate = waitForRuntimeOwnerAssignment(environment, cwd, 202, { pollMs: 1, timeoutMs: 1_000 }).then(() => {
      gateOpened = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateOpened).toBe(false);

    await writeAssignment(layout.assignmentFilePath, { schemaVersion: 1, topology: SUPPORTED_RUNTIME_TOPOLOGY, ownerId: lease.id, ownerRecordSha256: createHash("sha256").update(ownerRaw).digest("hex"), pid: 202, assignedAt: "2026-08-18T00:00:00.000Z" });
    await gate;
    expect(gateOpened).toBe(true);
  });

  it("does not let parent exit cleanup delete a lease after child PID handoff", async () => {
    const cwd = await createTempDir();
    const environment = environmentFor();
    const parentPid = process.pid;
    const childPid = parentPid + 10_000;
    const lease = await acquireRuntimeOwnerLease({ cwd, environment, pid: parentPid });
    leases.push(lease);
    const initialRaw = await readFile(lease.ownerFilePath, "utf8");
    expect(shouldReleaseRuntimeOwnerOnProcessExit(initialRaw, null, lease.id, parentPid)).toBe(true);

    await lease.assignProcess(childPid);
    const handedOffRaw = await readFile(lease.ownerFilePath, "utf8");
    const assignmentRaw = await readFile(lease.assignmentFilePath, "utf8");
    expect(handedOffRaw).toBe(initialRaw);
    expect(shouldReleaseRuntimeOwnerOnProcessExit(handedOffRaw, assignmentRaw, lease.id, parentPid)).toBe(false);
    expect(shouldReleaseRuntimeOwnerOnProcessExit(handedOffRaw, assignmentRaw, lease.id, childPid)).toBe(false);
  });

  it("fails closed for a dead same-host owner until its exact artifacts are manually removed", async () => {
    const cwd = await createTempDir();
    const environment = environmentFor();
    const { ownerFilePath } = resolveRuntimeStorageLayout(environment, cwd);
    await writeOwner(ownerFilePath, { schemaVersion: 1, topology: SUPPORTED_RUNTIME_TOPOLOGY, ownerId: "old-owner", hostname: "host-a", pid: 303, startedAt: "2026-08-18T00:00:00.000Z" });
    const staleRaw = await readFile(ownerFilePath, "utf8");

    await expect(acquireRuntimeOwnerLease({ cwd, environment, hostname: "host-a", pid: 404 })).rejects.toThrow("never automatically reclaims");
    expect(await readFile(ownerFilePath, "utf8")).toBe(staleRaw);

    await rm(ownerFilePath);
    const lease = await acquireRuntimeOwnerLease({ cwd, environment, hostname: "host-a", pid: 404 });
    leases.push(lease);
    expect(JSON.parse(await readFile(ownerFilePath, "utf8"))).toMatchObject({ ownerId: lease.id, hostname: "host-a", pid: 404 });
  });

  it("fails closed for live, foreign-host, and malformed owners", async () => {
    const cases = [
      { name: "live", owner: { schemaVersion: 1, topology: SUPPORTED_RUNTIME_TOPOLOGY, ownerId: "live-owner", hostname: "host-a", pid: 505, startedAt: "2026-08-18T00:00:00.000Z" } },
      { name: "foreign", owner: { schemaVersion: 1, topology: SUPPORTED_RUNTIME_TOPOLOGY, ownerId: "foreign-owner", hostname: "host-b", pid: 606, startedAt: "2026-08-18T00:00:00.000Z" } },
      { name: "malformed", owner: { unexpected: true } },
    ];

    for (const testCase of cases) {
      const cwd = await createTempDir();
      const environment = environmentFor();
      const { ownerFilePath } = resolveRuntimeStorageLayout(environment, cwd);
      await writeOwner(ownerFilePath, testCase.owner);
      await expect(acquireRuntimeOwnerLease({ cwd, environment, hostname: "host-a", pid: 707 })).rejects.toThrow(testCase.name === "malformed" ? "unreadable owner record" : "Refusing to start");
      await expect(readFile(ownerFilePath, "utf8")).resolves.toContain(testCase.name === "malformed" ? "unexpected" : String(testCase.owner.ownerId));
    }
  });

  it("does not overwrite missing, changed, or already-assigned ownership during child handoff", async () => {
    const missingCwd = await createTempDir();
    const missingEnvironment = environmentFor();
    const missingLayout = resolveRuntimeStorageLayout(missingEnvironment, missingCwd);
    const missingLease = await acquireRuntimeOwnerLease({ cwd: missingCwd, environment: missingEnvironment, hostname: "host-a", pid: 801 });
    leases.push(missingLease);
    await rm(missingLayout.ownerFilePath);
    await expect(missingLease.assignProcess(802)).rejects.toThrow("missing or no longer matches");
    await expect(stat(missingLayout.assignmentFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    await missingLease.release();
    leases.splice(leases.indexOf(missingLease), 1);

    const changedCwd = await createTempDir();
    const changedEnvironment = environmentFor();
    const changedLayout = resolveRuntimeStorageLayout(changedEnvironment, changedCwd);
    const changedLease = await acquireRuntimeOwnerLease({ cwd: changedCwd, environment: changedEnvironment, hostname: "host-a", pid: 803 });
    leases.push(changedLease);
    await writeOwner(changedLayout.ownerFilePath, { schemaVersion: 1, topology: SUPPORTED_RUNTIME_TOPOLOGY, ownerId: "replacement-owner", hostname: "host-b", pid: 804, startedAt: "2026-08-18T00:00:00.000Z" });
    const replacementRaw = await readFile(changedLayout.ownerFilePath, "utf8");
    await expect(changedLease.assignProcess(805)).rejects.toThrow("missing or no longer matches");
    expect(await readFile(changedLayout.ownerFilePath, "utf8")).toBe(replacementRaw);
    await expect(stat(changedLayout.assignmentFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    await changedLease.release();
    leases.splice(leases.indexOf(changedLease), 1);

    const assignedCwd = await createTempDir();
    const assignedEnvironment = environmentFor();
    const assignedLayout = resolveRuntimeStorageLayout(assignedEnvironment, assignedCwd);
    const assignedLease = await acquireRuntimeOwnerLease({ cwd: assignedCwd, environment: assignedEnvironment, hostname: "host-a", pid: 806 });
    leases.push(assignedLease);
    const immutableOwnerRaw = await readFile(assignedLayout.ownerFilePath, "utf8");
    await writeAssignment(assignedLayout.assignmentFilePath, { schemaVersion: 1, topology: SUPPORTED_RUNTIME_TOPOLOGY, ownerId: "different-owner", pid: 807, assignedAt: "2026-08-18T00:00:00.000Z" });
    const existingAssignmentRaw = await readFile(assignedLayout.assignmentFilePath, "utf8");
    await expect(assignedLease.assignProcess(808)).rejects.toThrow("already exists");
    expect(await readFile(assignedLayout.ownerFilePath, "utf8")).toBe(immutableOwnerRaw);
    expect(await readFile(assignedLayout.assignmentFilePath, "utf8")).toBe(existingAssignmentRaw);
  });

  it("fails closed when an orphaned child-assignment artifact exists", async () => {
    const cwd = await createTempDir();
    const environment = environmentFor();
    const layout = resolveRuntimeStorageLayout(environment, cwd);
    await writeAssignment(layout.assignmentFilePath, { unexpected: true });

    await expect(acquireRuntimeOwnerLease({ cwd, environment })).rejects.toThrow("child-assignment file still exists");
    await expect(stat(layout.ownerFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(layout.assignmentFilePath, "utf8")).resolves.toContain("unexpected");
  });

  it("rejects a missing or mismatched inherited owner nonce", async () => {
    const cwd = await createTempDir();
    const environment = environmentFor();
    await expect(verifyInheritedRuntimeOwnerLease(environment, cwd)).rejects.toThrow("No runtime owner lease was inherited");

    const { ownerFilePath } = resolveRuntimeStorageLayout(environment, cwd);
    environment[RUNTIME_OWNER_ID_ENV] = "expected-owner";
    await writeOwner(ownerFilePath, { schemaVersion: 1, topology: SUPPORTED_RUNTIME_TOPOLOGY, ownerId: "different-owner", hostname: "host-a", pid: 808, startedAt: "2026-08-18T00:00:00.000Z" });
    await expect(verifyInheritedRuntimeOwnerLease(environment, cwd)).rejects.toThrow("does not match");
  });
});
