-- Add status, is_used, and not_in_latest_export columns to vouchers table in Supabase
ALTER TABLE public.vouchers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE public.vouchers ADD COLUMN IF NOT EXISTS is_used BOOLEAN DEFAULT false;
ALTER TABLE public.vouchers ADD COLUMN IF NOT EXISTS not_in_latest_export BOOLEAN DEFAULT false;
