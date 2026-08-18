import { createRequire } from "node:module";

import { waitForRuntimeOwnerAssignment } from "../src/lib/runtime-topology.mjs";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

try {
  await waitForRuntimeOwnerAssignment();
  process.argv = [process.argv[0], nextBin, ...process.argv.slice(2)];
  require(nextBin);
} catch (error) {
  console.error(`[vicky] ${error instanceof Error ? error.message : "Next.js child ownership handoff failed unexpectedly."}`);
  process.exit(1);
}
