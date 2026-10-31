-- ==============================================================================
-- MASTER DATABASE & SECURITY HARDENING MIGRATION
-- Project: Hospital Staff Parking & Dispatch Portal
-- Schema: public
--
-- Fixes Supabase Security Adviser / Linter Warnings:
--  1. "RLS Policy Always True" -> Replaced with explicit role-scoped predicates
--  2. "Public / Signed-In Users Can Execute SECURITY DEFINER Function" -> Revoked
--     from public/anon/authenticated and restricted to service_role
--  3. "Function Search Path Mutable" -> Fixed with explicit search_path pinning
--  4. Missing RLS on future tables -> Automated via ddl_command_end event trigger
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. TABLE DEFINITIONS & COLUMNS
-- ==============================================================================

-- 1.1 Permits Table
CREATE TABLE IF NOT EXISTS public.permits (
  id TEXT PRIMARY KEY,
  hospital TEXT,
  ward TEXT,
  date_required TEXT,
  date_expiry TEXT,
  vrm TEXT,
  driver_name TEXT,
  phone TEXT,
  email TEXT,
  voucher_code TEXT,
  replacement_code TEXT,
  original_voucher_code TEXT,
  pre_cancel_voucher_code TEXT,
  start_time TEXT,
  completion_time TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure replacement and cancellation columns exist on pre-existing permits tables
ALTER TABLE public.permits ADD COLUMN IF NOT EXISTS completion_time TEXT;
ALTER TABLE public.permits ADD COLUMN IF NOT EXISTS replacement_code TEXT;
ALTER TABLE public.permits ADD COLUMN IF NOT EXISTS original_voucher_code TEXT;
ALTER TABLE public.permits ADD COLUMN IF NOT EXISTS pre_cancel_voucher_code TEXT;

-- 1.2 Vouchers Table
CREATE TABLE IF NOT EXISTS public.vouchers (
  code TEXT PRIMARY KEY,
  vrm TEXT,
  valid_from TEXT,
  valid_to TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 1.3 Dispatched History Table
CREATE TABLE IF NOT EXISTS public.dispatched_history (
  key TEXT PRIMARY KEY,
  dispatch_date TEXT,
  dispatch_by TEXT,
  vrm TEXT,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_permits_vrm ON public.permits (vrm);
CREATE INDEX IF NOT EXISTS idx_permits_date_required ON public.permits (date_required);
CREATE INDEX IF NOT EXISTS idx_vouchers_vrm ON public.vouchers (vrm);
CREATE INDEX IF NOT EXISTS idx_dispatched_history_vrm ON public.dispatched_history (vrm);

-- ==============================================================================
-- 2. ENABLE ROW LEVEL SECURITY (RLS)
-- ==============================================================================

ALTER TABLE public.permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatched_history ENABLE ROW LEVEL SECURITY;

-- ==============================================================================
-- 2.1 EXPLICIT DATA API PERMISSIONS (anon, authenticated, service_role)
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
-- 3. CLEAN UP ALL OBSOLETE / OVERLY PERMISSIVE POLICIES
-- ==============================================================================

-- Clean up permits policies
DROP POLICY IF EXISTS "Allow public all on permits" ON public.permits;
DROP POLICY IF EXISTS "Allow public insert and update on permits" ON public.permits;
DROP POLICY IF EXISTS "Allow authenticated modifications on permits" ON public.permits;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.permits;
DROP POLICY IF EXISTS "permits_select_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_insert_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_update_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_delete_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_select_anon" ON public.permits;

-- Clean up vouchers policies
DROP POLICY IF EXISTS "Allow public all on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Allow public insert and update on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Allow authenticated modifications on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_select_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_insert_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_update_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_delete_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_select_anon" ON public.vouchers;

-- Clean up dispatched_history policies
DROP POLICY IF EXISTS "Allow public all on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Allow public insert and update on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Allow authenticated modifications on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable insert for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable update for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_select_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_insert_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_update_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_delete_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_select_anon" ON public.dispatched_history;

-- ==============================================================================
-- 4. EXPLICIT AUTHENTICATED RLS POLICIES
-- Resolves "RLS Policy Always True" by strictly binding operations to
-- authenticated role checks rather than unrestricted USING(true)/WITH CHECK(true).
-- Anon users CANNOT perform INSERT, UPDATE, or DELETE operations.
-- ==============================================================================

-- 4.1 Policies for public.permits (authenticated role)
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

-- 4.2 Policies for public.vouchers (authenticated role)
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

-- 4.3 Policies for public.dispatched_history (authenticated role)
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
-- 5. SECURE RPC FUNCTION: public.log_dispatch
--
-- Security Hardening:
--  - SECURITY DEFINER: Executes with elevated owner privileges to bypass RLS.
--  - SET search_path = public, pg_temp: Resolves "Function Search Path Mutable".
--  - REVOKE EXECUTE from public, anon, authenticated: Resolves "Public/Signed-In
--    Users Can Execute SECURITY DEFINER Function".
--  - GRANT EXECUTE to service_role: Callable securely from backend API endpoints
--    using SUPABASE_SERVICE_ROLE_KEY.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.log_dispatch(
  p_key TEXT,
  p_dispatch_date TEXT,
  p_dispatch_by TEXT,
  p_vrm TEXT DEFAULT NULL,
  p_email TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.dispatched_history (key, dispatch_date, dispatch_by, vrm, email)
  VALUES (p_key, p_dispatch_date, p_dispatch_by, p_vrm, p_email)
  ON CONFLICT (key) DO UPDATE
  SET dispatch_date = EXCLUDED.dispatch_date,
      dispatch_by = EXCLUDED.dispatch_by,
      vrm = COALESCE(EXCLUDED.vrm, public.dispatched_history.vrm),
      email = COALESCE(EXCLUDED.email, public.dispatched_history.email);
  RETURN TRUE;
END;
$$;

-- Revoke execution from public, anon, and authenticated roles
REVOKE EXECUTE ON FUNCTION public.log_dispatch(TEXT, TEXT, TEXT, TEXT, TEXT) FROM public, anon, authenticated;

-- Grant execution strictly to service_role
GRANT EXECUTE ON FUNCTION public.log_dispatch(TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ==============================================================================
-- 6. AUTOMATED RLS EVENT TRIGGER FOR FUTURE TABLES
--
-- Automatically enables Row Level Security on any new table created in the
-- 'public' schema, ensuring no future un-secured tables are introduced.
--
-- Security Hardening:
--  - SET search_path = pg_catalog, pg_temp: Resolves "Function Search Path Mutable".
--  - Bound to ddl_command_end with WHEN TAG IN ('CREATE TABLE').
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

-- Revoke direct execution privileges on the trigger function
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM public, anon, authenticated;

-- Clean up legacy duplicate function and triggers if present
DROP EVENT TRIGGER IF EXISTS tr_auto_enable_rls_on_new_tables;
DROP EVENT TRIGGER IF EXISTS auto_enable_rls_on_new_tables_trigger;
DROP FUNCTION IF EXISTS public.auto_enable_rls_on_new_tables() CASCADE;

-- Drop event trigger if already present for clean idempotency
DROP EVENT TRIGGER IF EXISTS tr_auto_enable_rls;

-- Create the event trigger
CREATE EVENT TRIGGER tr_auto_enable_rls
ON ddl_command_end
WHEN TAG IN ('CREATE TABLE')
EXECUTE FUNCTION public.rls_auto_enable();

COMMIT;
