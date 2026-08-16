import "server-only";
import { logInternalError } from "./errorReference";

// lib/dbErrorResponse.ts
//
// Prompt 4, M3, a raw Postgres/Supabase error's .message can name
// columns, constraints, or table structure (CWE-209, "Generation of Error
// Message Containing Sensitive Information"). This was already fixed in
// one specific spot (the release-failure leak in
// app/api/orders/[id]/approve/route.ts, Prompt 1) using the same
// logInternalError pattern this generalizes: log the real detail
// server-side with a reference code, return a generic message + that
// code to the client instead of `error.message` directly.
export function dbErrorResponse(scope: string, error: { message: string } | Error): Response {
  const ref = logInternalError(scope, error);
  return Response.json({ error: "Something went wrong on our end. Try again.", referenceCode: ref }, { status: 500 });
}
