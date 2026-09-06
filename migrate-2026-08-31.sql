-- Migration: payout bookkeeping columns
-- Run this ONCE against the live D1 database. schema.sql only creates tables
-- that don't exist yet, so on a database that already has data these columns
-- have to be added explicitly.
--
-- Run against production with:
--   npx wrangler d1 execute <YOUR_DB_NAME> --remote --file=./migrate-2026-08-31.sql
--
-- Try it on the local copy first (drop --remote) if you want a dry run.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS". If a statement fails with
-- "duplicate column name", that column is already there — remove that one
-- line and run the rest. Adding a nullable column rewrites no data and
-- locks nothing meaningful at this size.

-- Stripe's real processing fee for this job's charge, in cents. Comes out of
-- Sketrix's 5%, so platform_cents minus this is the platform's true net.
ALTER TABLE bookings ADD COLUMN stripe_fee_cents INTEGER;

-- What the payout split actually moved, in cents. Recorded once, so payouts
-- stay reconcilable against Stripe even after the percentages change.
ALTER TABLE bookings ADD COLUMN master_cents INTEGER;
ALTER TABLE bookings ADD COLUMN business_cents INTEGER;
ALTER TABLE bookings ADD COLUMN platform_cents INTEGER;

-- Confirms the shares that split-payment.js and complete.js now both read
-- from. Expected: 5 / 55 / 40, adding up to 100.
SELECT name, platform_fee_percent, business_share_percent, master_share_percent,
       platform_fee_percent + business_share_percent + master_share_percent AS total
FROM businesses;
