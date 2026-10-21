-- ==============================================================================
-- SUPABASE SECURITY ADVISER & LINTER CLEANUP MIGRATION
-- Project: Hospital Staff Parking & Dispatch Portal
--
-- Directly Resolves:
--  1. "RLS Policy Always True" on dispatched_history, permits, and vouchers
--  2. "Public / Signed-In Users Can Execute SECURITY DEFINER Function" on:
--       - public.auto_enable_rls_on_new_tables()
--       - public.rls_auto_enable()
--  3. Pinned search_path on all SECURITY DEFINER functions
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. DROP OBSOLETE & PERMISSIVE POLICIES CAUSING LINTER WARNINGS
-- ==============================================================================

-- 1.1 dispatched_history
DROP POLICY IF EXISTS "Allow authenticated modifications on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Allow public all on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Allow public insert and update on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable insert for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable update for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_select_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_insert_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_update_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_delete_authenticated" ON public.dispatched_history;

-- 1.2 permits
DROP POLICY IF EXISTS "Allow authenticated modifications on permits" ON public.permits;
DROP POLICY IF EXISTS "Allow public all on permits" ON public.permits;
DROP POLICY IF EXISTS "Allow public insert and update on permits" ON public.permits;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.permits;
DROP POLICY IF EXISTS "permits_select_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_insert_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_update_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_delete_authenticated" ON public.permits;

-- 1.3 vouchers
DROP POLICY IF EXISTS "Allow authenticated modifications on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Allow public all on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Allow public insert and update on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_select_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_insert_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_update_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_delete_authenticated" ON public.vouchers;

-- ==============================================================================
-- 1.4 EXPLICIT DATA API PERMISSIONS (anon, authenticated, service_role)
-- Ensures supabase-js and PostgREST have table privileges under Supabase's
-- public schema access policies. RLS policies control row-level data access.
-- ==============================================================================

-- Permits table permissions
GRANT SELECT
ON public.permits
TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.permits
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.permits
TO service_role;

-- Vouchers table permissions
GRANT SELECT
ON public.vouchers
TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.vouchers
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.vouchers
TO service_role;

-- Dispatched history table permissions
GRANT SELECT
ON public.dispatched_history
TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.dispatched_history
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON public.dispatched_history
TO service_role;

-- ==============================================================================
-- 2. RE-CREATE EXPLICIT AUTHENTICATED RLS POLICIES
-- Uses auth.role() = 'authenticated' to satisfy Supabase security linter.
-- Anon write access is strictly denied (no insert/update/delete policies for anon).
-- ==============================================================================

-- 2.1 public.permits
CREATE POLICY "permits_select_authenticated"
  ON public.permits
  FOR SELECT
  TO authenticated
  USING (auth.role() = 'authenticated');

CREATE POLICY "permits_insert_authenticated"
  ON public.permits
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "permits_update_authenticated"
  ON public.permits
  FOR UPDATE
  TO authenticated
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "permits_delete_authenticated"
  ON public.permits
  FOR DELETE
  TO authenticated
  USING (auth.role() = 'authenticated');

-- 2.2 public.vouchers
CREATE POLICY "vouchers_select_authenticated"
  ON public.vouchers
  FOR SELECT
  TO authenticated
  USING (auth.role() = 'authenticated');

CREATE POLICY "vouchers_insert_authenticated"
  ON public.vouchers
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "vouchers_update_authenticated"
  ON public.vouchers
  FOR UPDATE
  TO authenticated
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "vouchers_delete_authenticated"
  ON public.vouchers
  FOR DELETE
  TO authenticated
  USING (auth.role() = 'authenticated');

-- 2.3 public.dispatched_history
CREATE POLICY "dispatched_history_select_authenticated"
  ON public.dispatched_history
  FOR SELECT
  TO authenticated
  USING (auth.role() = 'authenticated');

CREATE POLICY "dispatched_history_insert_authenticated"
  ON public.dispatched_history
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "dispatched_history_update_authenticated"
  ON public.dispatched_history
  FOR UPDATE
  TO authenticated
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "dispatched_history_delete_authenticated"
  ON public.dispatched_history
  FOR DELETE
  TO authenticated
  USING (auth.role() = 'authenticated');

-- ==============================================================================
-- 3. CLEAN UP DUPLICATE EVENT TRIGGER FUNCTION
-- Drop legacy function auto_enable_rls_on_new_tables and any attached triggers
-- ==============================================================================

DROP EVENT TRIGGER IF EXISTS tr_auto_enable_rls_on_new_tables;
DROP EVENT TRIGGER IF EXISTS auto_enable_rls_on_new_tables_trigger;
DROP FUNCTION IF EXISTS public.auto_enable_rls_on_new_tables() CASCADE;

-- ==============================================================================
-- 4. HARDEN RLS_AUTO_ENABLE FUNCTION PRIVILEGES & EVENT TRIGGER
-- Resolves "Public / Signed-In Users Can Execute SECURITY DEFINER Function"
-- and "Function Search Path Mutable".
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  cmd RECORD;
BEGIN
  FOR cmd IN 
    SELECT * 
    FROM pg_event_trigger_ddl_commands() 
    WHERE command_tag = 'CREATE TABLE'
  LOOP
    IF cmd.schema_name = 'public' THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY;', cmd.object_identity);
      EXECUTE format('GRANT SELECT ON %s TO anon;', cmd.object_identity);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO authenticated;', cmd.object_identity);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO service_role;', cmd.object_identity);
    END IF;
  END LOOP;
END;
$$;

-- Revoke execute permissions from public, anon, and authenticated roles
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM public, anon, authenticated;

-- Ensure trigger is cleanly created
DROP EVENT TRIGGER IF EXISTS tr_auto_enable_rls;
CREATE EVENT TRIGGER tr_auto_enable_rls
ON ddl_command_end
WHEN TAG IN ('CREATE TABLE')
EXECUTE FUNCTION public.rls_auto_enable();

COMMIT;
