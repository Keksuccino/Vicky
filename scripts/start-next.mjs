import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { validateRuntimeSecretsOrExit } from "../src/lib/runtime-secret-startup.mjs";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");
const nextBin = require.resolve("next/dist/bin/next");

loadEnvConfig(process.cwd(), false);
validateRuntimeSecretsOrExit();

const child = spawn(process.execPath, [nextBin, "start", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
