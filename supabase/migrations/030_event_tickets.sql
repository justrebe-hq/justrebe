-- ============================================================
-- ReBe LIVE — event ticket sales.
--
-- First event: "A Night to Shift" — Ladies' Night Out
--   Thu Oct 8, 2026 · 6:30–9:30 PM · Passeros, Arlington Heights IL
--   $65/person · featuring Elizabeth Good, hosted by Danielle McLoughlin
--
-- FLOW (mirrors the cohort signup flow exactly):
--   1. Landing page inserts a row here with status='pending' and gets its id.
--   2. That id is passed to Stripe Checkout as metadata.signup_id.
--   3. On checkout.session.completed the webhook PATCHes this row to
--      status='paid' + stripe_session_id + paid_amount_cents + paid_at.
--
-- Because the row is written BEFORE payment, you keep the lead even when
-- someone abandons checkout — those stay status='pending'.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS event_tickets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_slug         TEXT NOT NULL DEFAULT 'night-to-shift',
  event_name         TEXT NOT NULL DEFAULT 'A Night to Shift - Ladies Night Out',
  full_name          TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT,                      -- optional on the form
  quantity           INT  NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid' | 'refunded' | 'cancelled'
  stripe_session_id  TEXT,
  paid_amount_cents  INT,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent         TEXT,
  CONSTRAINT event_tickets_status_chk CHECK (status IN ('pending','paid','refunded','cancelled')),
  CONSTRAINT event_tickets_qty_chk    CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS event_tickets_email_idx  ON event_tickets (LOWER(email));
CREATE INDEX IF NOT EXISTS event_tickets_event_idx  ON event_tickets (event_slug, status);
CREATE INDEX IF NOT EXISTS event_tickets_session_idx ON event_tickets (stripe_session_id);

-- RLS: anyone (even anon) may INSERT their own registration. Only signed-in
-- team members can read the list. The Stripe webhook uses the service role
-- key, which bypasses RLS, so it can PATCH rows to paid.
ALTER TABLE event_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone can register for an event" ON event_tickets;
CREATE POLICY "anyone can register for an event"
  ON event_tickets FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "team can read event tickets" ON event_tickets;
CREATE POLICY "team can read event tickets"
  ON event_tickets FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()));

-- Who's actually coming:
--   SELECT full_name, email, phone, paid_at
--   FROM event_tickets
--   WHERE event_slug = 'night-to-shift' AND status = 'paid'
--   ORDER BY paid_at;
--
-- Who started but didn't pay (worth a follow-up):
--   SELECT full_name, email, phone, created_at
--   FROM event_tickets
--   WHERE event_slug = 'night-to-shift' AND status = 'pending'
--   ORDER BY created_at DESC;
