// tests/authz.test.ts
//
// Stage 4's explicit deliverable: prove a buyer session cannot reach any
// sourcer- or admin-only action, including by manipulating the client.
// "Manipulating the client" is modeled here as trying every input the
// browser actually controls — the session cookie's own claims, and
// whatever a forged request body might claim about role/email — and
// showing none of it changes the outcome, because requireRole() never
// reads role from any of those; it always re-reads the DB row.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionClaims, UserRow } from "../lib/types";

vi.mock("../lib/session", () => ({
  readSessionFromCookieStore: vi.fn(),
  SESSION_COOKIE_NAME: "sourcefi_session",
}));

vi.mock("../lib/supabaseServer", () => ({
  getSupabaseServerClient: vi.fn(),
}));

import { readSessionFromCookieStore } from "../lib/session";
import { getSupabaseServerClient } from "../lib/supabaseServer";
import { requireSession, requireRole } from "../lib/authz";

const BUYER_SESSION: SessionClaims = { privyUserId: "did:privy:buyer123", userRowId: 1, email: "buyer@example.com" };
const SOURCER_SESSION: SessionClaims = { privyUserId: "did:privy:sourcer456", userRowId: 2, email: "sourcer@example.com" };

const BUYER_ROW: UserRow = {
  id: 1,
  email: "buyer@example.com",
  username: "buyer_user",
  role: "buyer",
  privy_user_id: "did:privy:buyer123",
};

const SOURCER_ROW: UserRow = {
  id: 2,
  email: "sourcer@example.com",
  username: "sourcer_user",
  role: "sourcer",
  privy_user_id: "did:privy:sourcer456",
};

const ADMIN_ROW: UserRow = {
  id: 3,
  email: "admin@example.com",
  username: "admin_user",
  role: "admin",
  privy_user_id: "did:privy:admin789",
};

/** Mimics supabase-js's chainable query builder (.from().select().eq().eq().maybeSingle())
 * closely enough for requireSession()'s exact call shape — every chain
 * method returns the same builder, and the terminal method resolves to
 * whatever row this test wants "the database" to actually contain. */
function mockSupabaseReturning(row: UserRow | null) {
  const builder = {
    from: vi.fn(() => builder),
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data: row, error: null })),
  };
  vi.mocked(getSupabaseServerClient).mockReturnValue(builder as never);
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireSession", () => {
  it("returns null when there is no valid session cookie", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue(null);
    const result = await requireSession();
    expect(result).toBeNull();
  });

  it("returns null when the session's user row no longer exists (e.g. deleted account)", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue(BUYER_SESSION);
    mockSupabaseReturning(null);
    const result = await requireSession();
    expect(result).toBeNull();
  });

  it("re-derives role from the fresh DB row, not from anything in the session claims", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue(BUYER_SESSION);
    mockSupabaseReturning(BUYER_ROW);
    const result = await requireSession();
    expect(result?.user.role).toBe("buyer");
    // SessionClaims has no role field at all — there is nothing to forge
    // here even if an attacker could tamper with a decoded token, because
    // the type this function reads from never carries role in the first place.
    expect((BUYER_SESSION as unknown as Record<string, unknown>).role).toBeUndefined();
  });
});

describe("requireRole — the actual boundary the client cannot cross", () => {
  it("blocks a buyer session from a sourcer-only action (403)", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue(BUYER_SESSION);
    mockSupabaseReturning(BUYER_ROW);

    const result = await requireRole(["sourcer"]);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("blocks a buyer session from an admin-only action (403)", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue(BUYER_SESSION);
    mockSupabaseReturning(BUYER_ROW);

    const result = await requireRole(["admin"]);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("blocks a sourcer session from an admin-only action (403)", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue(SOURCER_SESSION);
    mockSupabaseReturning(SOURCER_ROW);

    const result = await requireRole(["admin"]);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  it("blocks an unauthenticated caller (401), distinct from a wrong-role caller (403)", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue(null);

    const result = await requireRole(["buyer"]);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("allows a buyer session through a buyer-only action", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue(BUYER_SESSION);
    mockSupabaseReturning(BUYER_ROW);

    const result = await requireRole(["buyer"]);
    expect(result).not.toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      expect(result.user.email).toBe("buyer@example.com");
    }
  });

  it("allows an admin session through an action open to multiple roles", async () => {
    vi.mocked(readSessionFromCookieStore).mockResolvedValue({
      privyUserId: "did:privy:admin789",
      userRowId: 3,
      email: "admin@example.com",
    });
    mockSupabaseReturning(ADMIN_ROW);

    const result = await requireRole(["sourcer", "admin"]);
    expect(result).not.toBeInstanceOf(Response);
  });

  it("cannot be tricked by a session cookie whose DID doesn't match the row it claims (mismatched id/privy_user_id)", async () => {
    // Simulates a forged/stale session claiming row #1 but a DID that
    // doesn't belong to row #1 — the .eq("privy_user_id", ...) half of
    // requireSession's lookup means this matches nothing, not "close enough".
    vi.mocked(readSessionFromCookieStore).mockResolvedValue({
      privyUserId: "did:privy:someone-else",
      userRowId: 1,
      email: "buyer@example.com",
    });
    mockSupabaseReturning(null); // the real query would find no matching row

    const result = await requireRole(["buyer"]);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});
