import { createRequire } from "node:module";

import { validateRuntimeSecretsOrExit } from "../src/lib/runtime-secret-startup.mjs";
import { launchOwnedNextRuntimeOrExit } from "./next-runtime-launcher.mjs";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd(), false);
validateRuntimeSecretsOrExit();
await launchOwnedNextRuntimeOrExit("start", process.argv.slice(2));
