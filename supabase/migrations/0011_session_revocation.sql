-- 0011_session_revocation.sql
--
-- Prompt 4 (security review), finding M5, the session cookie is a
-- stateless signed JWT (lib/session.ts); clearing it on logout only
-- removes it from the current device, the token itself stays valid until
-- its 12h expiry. This column is what makes "logout on all devices"
-- actually true: every session token issued before this timestamp is
-- rejected on its next request, regardless of how many devices hold a
-- copy, see lib/authz.ts's requireSession().

alter table users add column if not exists session_valid_after timestamptz;
