-- Migration v12: SharedSet for master negatives + account-wide mobile-app block
-- Run in Supabase SQL Editor

-- ============================================================
-- 1. Per-client shared-set + mobile-app state
-- ============================================================
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS master_shared_set_resource_name VARCHAR(200);

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS block_mobile_apps BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS mobile_apps_blocked_at TIMESTAMPTZ;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS master_negatives_synced_at TIMESTAMPTZ;

-- ============================================================
-- 2. match_type on general_negatives (PHRASE default per decision)
-- ============================================================
ALTER TABLE general_negatives
  ADD COLUMN IF NOT EXISTS match_type VARCHAR(10) NOT NULL DEFAULT 'phrase';

ALTER TABLE general_negatives
  DROP CONSTRAINT IF EXISTS chk_general_negatives_match_type;
ALTER TABLE general_negatives
  ADD CONSTRAINT chk_general_negatives_match_type
  CHECK (match_type IN ('exact', 'phrase', 'broad'));

-- ============================================================
-- 3. Global defaults on app_settings
-- ============================================================
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS default_block_mobile_apps BOOLEAN NOT NULL DEFAULT TRUE;

-- Google's mobileAppCategoryConstants/69500 maps to the catch-all "apps" category.
-- Made configurable in case Google shuffles the taxonomy.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS mobile_app_category_id VARCHAR(20) NOT NULL DEFAULT '69500';
