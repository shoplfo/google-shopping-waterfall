-- ============================================================
-- Migration V4: Add is_active to vendors and vendor_keywords
-- Run this in Supabase SQL Editor AFTER migration-v3.sql
-- ============================================================

ALTER TABLE vendors ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE vendor_keywords ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- ============================================================
-- Done! Verify with:
-- SELECT id, name, is_active FROM vendors LIMIT 5;
-- SELECT id, keyword, is_active FROM vendor_keywords LIMIT 5;
-- ============================================================
