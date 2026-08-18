import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";

import { validateRuntimeSecretsOrExit } from "../src/lib/runtime-secret-startup.mjs";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
const nextBin = require.resolve("next/dist/bin/next");
const forwardedArgs = process.argv.slice(2);

loadEnvConfig(process.cwd(), true);
validateRuntimeSecretsOrExit();

const isWsl =
  process.platform === "linux" &&
  (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(os.release()));
const isMountedWindowsDrive = /^\/mnt\/[a-z](\/|$)/i.test(process.cwd());
const bundlerExplicitlySelected = forwardedArgs.some((arg) => arg === "--webpack" || arg === "--turbo" || arg === "--turbopack");
const usePollingFallback = isWsl && isMountedWindowsDrive && !bundlerExplicitlySelected;

if (usePollingFallback) {
  console.log("[dev] WSL mounted drive detected. Using webpack polling for reliable refresh.");
}

const child = spawn(
  process.execPath,
  [nextBin, "dev", ...(usePollingFallback ? ["--webpack"] : []), ...forwardedArgs],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(usePollingFallback
        ? {
            WATCHPACK_POLLING: "true",
            CHOKIDAR_USEPOLLING: "true",
          }
        : {}),
    },
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
