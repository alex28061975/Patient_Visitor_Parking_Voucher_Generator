-- ============================================================
-- Migration: Add voucher replacement tracking columns
-- ============================================================

ALTER TABLE public.permits ADD COLUMN IF NOT EXISTS replacement_code TEXT;
ALTER TABLE public.permits ADD COLUMN IF NOT EXISTS original_voucher_code TEXT;
ALTER TABLE public.permits ADD COLUMN IF NOT EXISTS pre_cancel_voucher_code TEXT;
