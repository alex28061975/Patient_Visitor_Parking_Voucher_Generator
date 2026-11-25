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
  status TEXT DEFAULT 'active',
  is_used BOOLEAN DEFAULT false,
  not_in_latest_export BOOLEAN DEFAULT false,
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

-- ============================================================
-- 5. Silent Blocklist Table & Atomic Replacement RPC
-- ============================================================
CREATE TABLE IF NOT EXISTS public.blocklist (
  id TEXT PRIMARY KEY,
  form_id TEXT,
  hospital_site TEXT,
  ward_dept TEXT,
  date_required TEXT,
  expiry_date TEXT,
  vrm TEXT NOT NULL,
  driver_name TEXT,
  phone TEXT,
  email TEXT,
  voucher_code TEXT,
  reason TEXT NOT NULL,
  added_at TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocklist_vrm ON public.blocklist (vrm);

ALTER TABLE public.blocklist ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.blocklist FROM anon, public;
GRANT SELECT ON public.blocklist TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.blocklist TO service_role;

DROP POLICY IF EXISTS "Allow public all on blocklist" ON public.blocklist;
DROP POLICY IF EXISTS "blocklist_select_authenticated" ON public.blocklist;
CREATE POLICY "blocklist_select_authenticated"
  ON public.blocklist
  FOR SELECT
  TO authenticated
  USING (auth.role() = 'authenticated');

CREATE OR REPLACE FUNCTION public.replace_blocklist(entries JSONB)
RETURNS SETOF public.blocklist
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  IF entries IS NULL OR jsonb_typeof(entries) <> 'array' THEN
    RAISE EXCEPTION 'entries must be a JSON array';
  END IF;

  SELECT jsonb_array_length(entries) INTO v_count;

  DELETE FROM public.blocklist b
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(entries) AS x(
      id TEXT,
      form_id TEXT,
      hospital_site TEXT,
      ward_dept TEXT,
      date_required TEXT,
      expiry_date TEXT,
      vrm TEXT,
      driver_name TEXT,
      phone TEXT,
      email TEXT,
      voucher_code TEXT,
      reason TEXT,
      added_at TEXT
    )
    WHERE UPPER(REGEXP_REPLACE(COALESCE(x.vrm, ''), '\s+', '', 'g')) =
          UPPER(REGEXP_REPLACE(COALESCE(b.vrm, ''), '\s+', '', 'g'))
  );

  IF v_count > 0 THEN
    INSERT INTO public.blocklist (
      id, form_id, hospital_site, ward_dept, date_required, expiry_date,
      vrm, driver_name, phone, email, voucher_code, reason, added_at
    )
    SELECT
      COALESCE(NULLIF(TRIM(x.id), ''), 'blk_' || md5(UPPER(REGEXP_REPLACE(x.vrm, '\s+', '', 'g')))),
      x.form_id,
      x.hospital_site,
      x.ward_dept,
      x.date_required,
      x.expiry_date,
      UPPER(TRIM(x.vrm)),
      x.driver_name,
      x.phone,
      x.email,
      COALESCE(NULLIF(TRIM(x.voucher_code), ''), 'BLOCKED'),
      COALESCE(NULLIF(TRIM(x.reason), ''), 'Administrative block'),
      COALESCE(NULLIF(TRIM(x.added_at), ''), NOW()::TEXT)
    FROM jsonb_to_recordset(entries) AS x(
      id TEXT,
      form_id TEXT,
      hospital_site TEXT,
      ward_dept TEXT,
      date_required TEXT,
      expiry_date TEXT,
      vrm TEXT,
      driver_name TEXT,
      phone TEXT,
      email TEXT,
      voucher_code TEXT,
      reason TEXT,
      added_at TEXT
    )
    ON CONFLICT (vrm) DO UPDATE SET
      id = EXCLUDED.id,
      form_id = EXCLUDED.form_id,
      hospital_site = EXCLUDED.hospital_site,
      ward_dept = EXCLUDED.ward_dept,
      date_required = EXCLUDED.date_required,
      expiry_date = EXCLUDED.expiry_date,
      driver_name = EXCLUDED.driver_name,
      phone = EXCLUDED.phone,
      email = EXCLUDED.email,
      voucher_code = EXCLUDED.voucher_code,
      reason = EXCLUDED.reason,
      added_at = EXCLUDED.added_at;
  END IF;

  RETURN QUERY SELECT * FROM public.blocklist ORDER BY added_at DESC NULLS LAST, id ASC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_blocklist(JSONB) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_blocklist(JSONB) TO service_role;


