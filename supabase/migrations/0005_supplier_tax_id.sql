-- 0005_supplier_tax_id.sql
--
-- Adds a tax ID number (Nigerian TIN) to both the verification
-- application and the resulting supplier profile — additive only,
-- idempotent, safe to re-run, matching every migration before it.
alter table supplier_verification_applications
  add column if not exists tax_id_number text;

alter table supplier_profiles
  add column if not exists tax_id_number text;
