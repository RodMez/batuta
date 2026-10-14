import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
    // 15s por defecto para suites con git/worktrees reales en Windows;
    // los 2 tests con spawn pesado usan 30s explícitos.
    testTimeout: 15_000,
  },
});

