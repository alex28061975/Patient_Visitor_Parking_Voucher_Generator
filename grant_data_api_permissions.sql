-- ==============================================================================
-- SUPABASE DATA API PERMISSION GRANTS
-- Project: Hospital Staff Parking & Dispatch Portal
-- Schema: public
--
-- Explicitly grants table permissions to anon, authenticated, and service_role
-- to prepare for Supabase's upcoming public schema access policy change.
-- Prevents "permission denied" errors when accessing tables via PostgREST / supabase-js.
-- ==============================================================================

BEGIN;

-- 1. Permits table permissions
GRANT SELECT
ON public.permits
TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.permits
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.permits
TO service_role;

-- 2. Vouchers table permissions
GRANT SELECT
ON public.vouchers
TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.vouchers
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.vouchers
TO service_role;

-- 3. Dispatched history table permissions
GRANT SELECT
ON public.dispatched_history
TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.dispatched_history
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.dispatched_history
TO service_role;

COMMIT;
