import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node", // server-side route/authz logic only, no DOM needed
    include: ["tests/**/*.test.ts"],
  },
});
