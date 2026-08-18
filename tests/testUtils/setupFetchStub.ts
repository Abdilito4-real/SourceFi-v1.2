// tests/testUtils/setupFetchStub.ts
//
// lib/fxRate.ts calls the real, live NGN/USD rate API via global fetch,
// tests must never depend on a real network call (slow, flaky, and
// exactly what tests/testUtils/fakeSupabase.ts already exists to avoid
// on the DB side). Loaded once for every test file via vitest.config.ts's
// `setupFiles`, so every test gets a fast, deterministic rate without
// having to know this exists. A test that specifically needs to
// exercise fxRate's OWN fetch-failure/caching behavior (tests/fxRate.test.ts)
// overrides global.fetch itself and restores this default afterward.
import { vi, afterEach } from "vitest";

export const TEST_NGN_PER_USD = 1600;

export function defaultFetchStub(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes("open.er-api.com")) {
    return Promise.resolve(new Response(JSON.stringify({ rates: { NGN: TEST_NGN_PER_USD } }), { status: 200 }));
  }
  // Any other fetch is unexpected in this suite, fail loudly rather than
  // silently hitting the real network from a unit test.
  return Promise.reject(new Error(`Unexpected fetch() in tests: ${url}`));
}

vi.stubGlobal("fetch", vi.fn(defaultFetchStub));

// A test file that overrides global.fetch for its own scenarios (fxRate.test.ts)
// must not leak that override into the next test file in the same run.
afterEach(() => {
  vi.stubGlobal("fetch", vi.fn(defaultFetchStub));
});
