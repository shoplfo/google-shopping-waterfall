-- Migration v11: Income exclusions, observation audiences, URL hygiene
-- Run in Supabase SQL Editor

-- Per-client income exclusion override.
-- Presets map to a set of INCOME_RANGE buckets that get added as NEGATIVE campaign criteria:
--   none     → nothing excluded
--   lower_50 → excludes INCOME_RANGE_0_50
--   lower_60 → excludes 0_50 + 50_60 (target top 40%)
--   lower_70 → excludes 0_50 + 50_60 + 60_70 (target top 30%)
--   lower_80 → excludes 0_50 + 50_60 + 60_70 + 70_80 (target top 20%)
--   lower_90 → excludes 0_50 + 50_60 + 60_70 + 70_80 + 80_90 (target top 10%)
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS income_exclusion VARCHAR(20) NOT NULL DEFAULT 'none';

ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS chk_clients_income_exclusion;
ALTER TABLE clients
  ADD CONSTRAINT chk_clients_income_exclusion
  CHECK (income_exclusion IN ('none','lower_50','lower_60','lower_70','lower_80','lower_90'));

-- Global default income exclusion (inherited by new clients)
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS default_income_exclusion VARCHAR(20) NOT NULL DEFAULT 'none';

ALTER TABLE app_settings
  DROP CONSTRAINT IF EXISTS chk_app_settings_default_income_exclusion;
ALTER TABLE app_settings
  ADD CONSTRAINT chk_app_settings_default_income_exclusion
  CHECK (default_income_exclusion IN ('none','lower_50','lower_60','lower_70','lower_80','lower_90'));

-- Global observation audiences: array of in-market / affinity audience criterion IDs
-- (strings; applied as user_interest criteria in Observation mode on every new campaign).
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS default_observation_audiences JSONB NOT NULL DEFAULT '[]'::jsonb;
