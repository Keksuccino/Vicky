import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { acquireRuntimeOwnerLease } from "../src/lib/runtime-topology.mjs";

const childBootstrap = fileURLToPath(new URL("./next-runtime-child.mjs", import.meta.url));
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM"];

export async function launchOwnedNextRuntime(command, args, environment = process.env) {
  const lease = await acquireRuntimeOwnerLease({ environment });
  let child;

  try {
    // The bootstrap waits for the atomic PID handoff before importing Next. Keep this
    // gate intact: it closes the parent-SIGKILL window described in runtime-topology.mjs.
    child = spawn(process.execPath, [childBootstrap, command, ...args], { stdio: "inherit", env: environment });
  } catch (error) {
    await lease.release();
    throw error;
  }
  const outcomePromise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, error, signal: null }));
    child.once("exit", (code, signal) => resolve({ code, error: null, signal }));
  });

  const signalHandlers = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    if (!child.pid) {
      throw new Error(`Failed to start Next.js ${command}: the child process has no PID.`);
    }
    await lease.assignProcess(child.pid);

    const outcome = await outcomePromise;
    if (outcome.error) {
      throw outcome.error;
    }
    await lease.release();

    if (outcome.signal) {
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      process.kill(process.pid, outcome.signal);
      return;
    }

    process.exitCode = outcome.code ?? 0;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await outcomePromise;
    }
    await lease.release().catch(() => undefined);
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
}

export async function launchOwnedNextRuntimeOrExit(command, args, environment = process.env) {
  try {
    await launchOwnedNextRuntime(command, args, environment);
  } catch (error) {
    console.error(`[vicky] ${error instanceof Error ? error.message : "Next.js runtime startup failed unexpectedly."}`);
    process.exitCode = 1;
  }
}
