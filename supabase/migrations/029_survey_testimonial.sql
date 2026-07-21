-- ============================================================
-- ReBe ReFresh — add testimonial capture to cohort surveys.
--
-- The post-survey (cohort-1-survey-post.html) asks participants to
-- write a testimonial in their own words, plus whether we may share
-- it publicly (first name + last initial).
--
--   testimonial             — their words, free text. NULL if skipped.
--   testimonial_permission  — 'yes' | 'no'. NULL when no testimonial.
--
-- Additive and safe to re-run. Existing rows get NULL.
-- The post-survey page works with or without this migration — without
-- it, the testimonial is appended onto hope_comment instead. Running
-- this just gives you a clean, separate column to pull quotes from.
--
-- Run in the Supabase SQL editor.
-- ============================================================

ALTER TABLE cohort_surveys ADD COLUMN IF NOT EXISTS testimonial            TEXT;
ALTER TABLE cohort_surveys ADD COLUMN IF NOT EXISTS testimonial_permission TEXT;

ALTER TABLE cohort_surveys DROP CONSTRAINT IF EXISTS testimonial_permission_chk;
ALTER TABLE cohort_surveys ADD  CONSTRAINT testimonial_permission_chk
  CHECK (testimonial_permission IS NULL OR testimonial_permission IN ('yes','no'));

-- Quick pull of every shareable quote:
--   SELECT full_name, email, testimonial, submitted_at
--   FROM cohort_surveys
--   WHERE survey_type = 'post'
--     AND testimonial IS NOT NULL
--     AND testimonial_permission = 'yes'
--   ORDER BY submitted_at DESC;
