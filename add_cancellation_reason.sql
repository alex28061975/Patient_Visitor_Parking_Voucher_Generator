ALTER TABLE public.permits
ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

UPDATE public.permits
SET cancellation_reason = 'MANUAL'
WHERE id = '2168';
