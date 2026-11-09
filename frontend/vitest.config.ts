import { defineConfig } from "vitest/config";

/**
 * Vitest runs the pure helpers (accrual math, amount parsing/formatting,
 * date<->unix conversion). No DOM is needed — the app's rendering is covered by
 * `tsc` + the production build.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
