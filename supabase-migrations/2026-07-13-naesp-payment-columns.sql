-- 2026-07-13 · Add card-payment tracking columns to naesp_orders
--
-- Run this in the Supabase SQL editor BEFORE the NAESP booth opens.
-- Without these columns, a card buyer refreshing the /NAESP-thank-you page
-- could send them a duplicate "Payment received" email each time.
--
-- Idempotent — safe to run more than once.

ALTER TABLE public.naesp_orders
  ADD COLUMN IF NOT EXISTS payment_status text,
  ADD COLUMN IF NOT EXISTS stripe_session_id text,
  ADD COLUMN IF NOT EXISTS payment_confirmed_email_sent_at timestamptz;

-- Speed up the idempotency lookup in /api/naesp-payment-confirmed
CREATE INDEX IF NOT EXISTS naesp_orders_stripe_session_id_idx
  ON public.naesp_orders (stripe_session_id);
