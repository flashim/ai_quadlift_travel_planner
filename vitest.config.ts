import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/orchestrator/**/*.test.ts", "apps/agent-*/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "apps/web/**"],
    environment: "node",
    testTimeout: 15_000,
  },
});
