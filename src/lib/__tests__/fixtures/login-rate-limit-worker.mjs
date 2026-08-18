import { createLoginRateLimitStorage } from "../../login-rate-limit-storage.mjs";

const config = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
const identity = process.argv[3];
const attempts = Number.parseInt(process.argv[4], 10);
const now = Number.parseInt(process.argv[5], 10);
const storage = createLoginRateLimitStorage({ ...config, legacyStorePath: null, now: () => now });

process.send?.({ type: "ready" });
process.once("message", (message) => {
  if (message !== "go") {
    storage.close();
    process.exitCode = 1;
    return;
  }

  try {
    const results = Array.from({ length: attempts }, () => storage.registerFailure(identity, now));
    storage.close();
    process.send?.({ type: "result", results }, () => process.disconnect?.());
  } catch (error) {
    storage.close();
    process.send?.({ type: "error", message: error instanceof Error ? error.message : String(error) }, () => process.disconnect?.());
    process.exitCode = 1;
  }
});
