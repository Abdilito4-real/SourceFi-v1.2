import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // "server-only" (Prompt 4, M2) throws unconditionally outside a
      // webpack build carrying Next's `react-server` resolve condition
      // which plain Node/Vitest never sets. Aliased to a local no-op so
      // lib/*.ts files that import it stay testable here, this doesn't
      // weaken the real protection, which is specifically about the
      // CLIENT webpack bundle (the package's own "exports" map blocks
      // reaching its own empty.js twin directly, hence a local stub
      // instead of pointing at the package's internals).
      "server-only": path.resolve(__dirname, "tests/testUtils/serverOnlyStub.ts"),
    },
  },
  test: {
    environment: "node", // server-side route/authz logic only, no DOM needed
    include: ["tests/**/*.test.ts"],
  },
});
