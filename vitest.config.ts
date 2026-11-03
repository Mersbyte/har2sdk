import { defineConfig } from "vitest/config";

// Many tests run the CLI in a child process or compile a generated client. On a slow CI runner
// (Windows) a few of them pass 5 s, vitest's default; a timeout there says nothing about har2sdk.
// Tests that measure speed set their own limits.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
