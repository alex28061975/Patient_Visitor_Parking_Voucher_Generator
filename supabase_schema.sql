-- ============================================================
-- Supabase Database Schema for Bart's Parking Concessions QR App
-- ============================================================
-- Instructions:
-- 1. Go to https://supabase.com and create a Free Project
-- 2. In your Supabase Dashboard, go to "SQL Editor"
-- 3. Paste and run this script to create all required tables & policies
-- 4. Copy your Supabase URL & Anon Key from Project Settings -> API
-- 5. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your environment variables
-- ============================================================

-- 1. Create Permits Table
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

-- 2. Create Vouchers Table
CREATE TABLE IF NOT EXISTS public.vouchers (
  code TEXT PRIMARY KEY,
  vrm TEXT,
  valid_from TEXT,
  valid_to TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create Dispatched History Table
CREATE TABLE IF NOT EXISTS public.dispatched_history (
  key TEXT PRIMARY KEY,
  dispatch_date TEXT,
  dispatch_by TEXT,
  vrm TEXT,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE public.permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatched_history ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- EXPLICIT DATA API PERMISSIONS (anon, authenticated, service_role)
-- Ensures supabase-js and PostgREST have table privileges under Supabase's
-- public schema access policies. RLS policies control row-level data access.
-- ============================================================

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

-- ============================================================
-- RLS POLICIES (Secure authenticated access; no open ALL true)
-- ============================================================

-- Clean up any overly permissive / obsolete policies
DROP POLICY IF EXISTS "Allow authenticated modifications on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Allow public insert and update on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Allow public all on dispatched_history" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable insert for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "Enable update for all users" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_select_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_insert_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_update_authenticated" ON public.dispatched_history;
DROP POLICY IF EXISTS "dispatched_history_delete_authenticated" ON public.dispatched_history;

CREATE POLICY "dispatched_history_select_authenticated" ON public.dispatched_history FOR SELECT TO authenticated USING (auth.role() = 'authenticated');
CREATE POLICY "dispatched_history_insert_authenticated" ON public.dispatched_history FOR INSERT TO authenticated WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "dispatched_history_update_authenticated" ON public.dispatched_history FOR UPDATE TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "dispatched_history_delete_authenticated" ON public.dispatched_history FOR DELETE TO authenticated USING (auth.role() = 'authenticated');

-- Permits policies
DROP POLICY IF EXISTS "Allow authenticated modifications on permits" ON public.permits;
DROP POLICY IF EXISTS "Allow public insert and update on permits" ON public.permits;
DROP POLICY IF EXISTS "Allow public all on permits" ON public.permits;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.permits;
DROP POLICY IF EXISTS "permits_select_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_insert_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_update_authenticated" ON public.permits;
DROP POLICY IF EXISTS "permits_delete_authenticated" ON public.permits;

CREATE POLICY "permits_select_authenticated" ON public.permits FOR SELECT TO authenticated USING (auth.role() = 'authenticated');
CREATE POLICY "permits_insert_authenticated" ON public.permits FOR INSERT TO authenticated WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "permits_update_authenticated" ON public.permits FOR UPDATE TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "permits_delete_authenticated" ON public.permits FOR DELETE TO authenticated USING (auth.role() = 'authenticated');

-- Vouchers policies
DROP POLICY IF EXISTS "Allow authenticated modifications on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Allow public insert and update on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "Allow public all on vouchers" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_select_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_insert_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_update_authenticated" ON public.vouchers;
DROP POLICY IF EXISTS "vouchers_delete_authenticated" ON public.vouchers;

CREATE POLICY "vouchers_select_authenticated" ON public.vouchers FOR SELECT TO authenticated USING (auth.role() = 'authenticated');
CREATE POLICY "vouchers_insert_authenticated" ON public.vouchers FOR INSERT TO authenticated WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "vouchers_update_authenticated" ON public.vouchers FOR UPDATE TO authenticated USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "vouchers_delete_authenticated" ON public.vouchers FOR DELETE TO authenticated USING (auth.role() = 'authenticated');

-- ============================================================
-- 4. RPC Function for administrative / safe dispatch logging
-- Declared with SECURITY DEFINER so that it bypasses RLS if called
-- by public / anon clients.
-- ============================================================
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

GRANT EXECUTE ON FUNCTION public.log_dispatch TO anon, authenticated, public;

