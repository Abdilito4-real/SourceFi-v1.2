// tests/testUtils/serverOnlyStub.ts
//
// Vitest alias target for the "server-only" package (see vitest.config.ts)
//, a plain `import "server-only"` in the real package throws outside a
// webpack build carrying Next's `react-server` resolve condition, which
// Vitest never sets. This is a no-op stand-in so lib/*.ts files that
// import "server-only" (Prompt 4, M2) stay testable here; it doesn't
// weaken the real protection, which is specifically about the client
// webpack bundle.
export {};
