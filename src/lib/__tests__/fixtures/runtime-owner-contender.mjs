import { acquireRuntimeOwnerLease, RUNTIME_TOPOLOGY_ENV, SUPPORTED_RUNTIME_TOPOLOGY } from "../../runtime-topology.mjs";

const runtimeDirectory = process.argv[2];
const environment = { NODE_ENV: "test", [RUNTIME_TOPOLOGY_ENV]: SUPPORTED_RUNTIME_TOPOLOGY };
let lease = null;

const send = (message) => new Promise((resolve) => process.send?.(message, resolve));

process.send?.({ type: "ready" });
process.on("message", async (message) => {
  if (message === "start") {
    try {
      lease = await acquireRuntimeOwnerLease({ cwd: runtimeDirectory, environment, hostname: "stress-host", pid: process.pid });
      await send({ type: "acquired", pid: process.pid });
    } catch (error) {
      await send({ type: "rejected", message: error instanceof Error ? error.message : String(error), pid: process.pid });
      process.disconnect?.();
    }
    return;
  }

  if (message === "release" && lease) {
    await lease.release();
    await send({ type: "released", pid: process.pid });
    process.disconnect?.();
  }
});
