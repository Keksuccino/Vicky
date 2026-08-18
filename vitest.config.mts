import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runtime fallbacks require this runner-owned signal in addition to Vitest's own
    // VITEST marker. NODE_ENV=test by itself deliberately grants nothing.
    env: {
      VICKY_AUTOMATED_TEST_RUN: "vitest",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
