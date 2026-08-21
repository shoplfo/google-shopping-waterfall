-- Migration v13: Remove income-exclusion framework.
-- Google Ads does not support household-income targeting on Shopping campaigns
-- (platform limitation, not an API bug — confirmed in Google Ads demographics docs).
-- This engine is Shopping-only, so the feature is removed.
--
-- Safe to run: these columns were introduced in v11 and never successfully
-- applied to any live campaigns. No data loss of operational value.
-- Run in Supabase SQL Editor

ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS chk_clients_income_exclusion;

ALTER TABLE clients
  DROP COLUMN IF EXISTS income_exclusion;

ALTER TABLE app_settings
  DROP CONSTRAINT IF EXISTS chk_app_settings_default_income_exclusion;

ALTER TABLE app_settings
  DROP COLUMN IF EXISTS default_income_exclusion;
