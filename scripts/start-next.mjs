import { createRequire } from "node:module";

import { validateRuntimeSecretsOrExit } from "../src/lib/runtime-secret-startup.mjs";
import { launchOwnedNextRuntimeOrExit } from "./next-runtime-launcher.mjs";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require("@next/env");

// Production unless NODE_ENV says otherwise, like `next start` itself; set here so the launcher's
// env loading and checks run in the same mode as the Next.js child that inherits it.
process.env.NODE_ENV ||= "production";
loadEnvConfig(process.cwd(), false);
validateRuntimeSecretsOrExit();
await launchOwnedNextRuntimeOrExit("start", process.argv.slice(2));
