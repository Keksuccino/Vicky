import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runtime fallbacks require this runner-owned signal in addition to Vitest's own
    // VITEST marker. NODE_ENV=test by itself deliberately grants nothing.
    env: {
      VICKY_AUTOMATED_TEST_RUN: "vitest",
    },
    // Keeps every runtime path out of the project's real data/ directory, blocks network access,
    // and unmounts rendered components after each test (see src/test/vitest-setup.ts).
    globalSetup: ["./src/test/vitest-global-setup.ts"],
    setupFiles: ["./src/test/vitest-setup.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
