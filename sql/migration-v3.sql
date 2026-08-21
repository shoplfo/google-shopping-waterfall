-- ============================================================
-- Migration V3: Make Vendors Global (not per-client)
-- Run this in Supabase SQL Editor AFTER migration-v2.sql
-- ============================================================

-- ============================================================
-- 1. Create client_vendors junction table
-- ============================================================
CREATE TABLE client_vendors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, vendor_id)
);

CREATE INDEX idx_client_vendors_client ON client_vendors(client_id);
CREATE INDEX idx_client_vendors_vendor ON client_vendors(vendor_id);

ALTER TABLE client_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_vendors_read_own" ON client_vendors
  FOR SELECT USING (auth.uid()::text = client_id::text);

CREATE POLICY "client_vendors_insert_own" ON client_vendors
  FOR INSERT WITH CHECK (auth.uid()::text = client_id::text);

CREATE POLICY "client_vendors_delete_own" ON client_vendors
  FOR DELETE USING (auth.uid()::text = client_id::text);

-- ============================================================
-- 2. Backfill client_vendors from existing vendors (which have client_id)
-- ============================================================
INSERT INTO client_vendors (client_id, vendor_id)
SELECT client_id, id FROM vendors
ON CONFLICT (client_id, vendor_id) DO NOTHING;

-- ============================================================
-- 3. Deduplicate vendors by name (keep the first one created)
-- ============================================================

-- Update vendor_keywords to point to the "keeper" vendor for each duplicate name
UPDATE vendor_keywords vk
SET vendor_id = keeper.id
FROM (
  SELECT name, (MIN(id::text))::uuid AS id
  FROM vendors
  GROUP BY name
) keeper
JOIN vendors v ON v.name = keeper.name AND v.id != keeper.id
WHERE vk.vendor_id = v.id;

-- Update client_vendors to point to the keeper vendor
UPDATE client_vendors cv
SET vendor_id = keeper.id
FROM (
  SELECT name, (MIN(id::text))::uuid AS id
  FROM vendors
  GROUP BY name
) keeper
JOIN vendors v ON v.name = keeper.name AND v.id != keeper.id
WHERE cv.vendor_id = v.id;

-- Remove duplicate client_vendors rows that now have the same (client_id, vendor_id)
DELETE FROM client_vendors a
USING client_vendors b
WHERE a.id > b.id
  AND a.client_id = b.client_id
  AND a.vendor_id = b.vendor_id;

-- Delete duplicate vendors (keep the one with MIN(id) per name)
DELETE FROM vendors
WHERE id NOT IN (
  SELECT (MIN(id::text))::uuid FROM vendors GROUP BY name
);

-- ============================================================
-- 4. Remove client_id from vendors table
-- ============================================================

-- Drop old RLS policies that reference client_id
DROP POLICY IF EXISTS "vendors_read_own" ON vendors;
DROP POLICY IF EXISTS "vendors_insert_own" ON vendors;
DROP POLICY IF EXISTS "vendors_delete_own" ON vendors;

-- Drop old index and constraint
DROP INDEX IF EXISTS idx_vendors_client;
ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_client_id_name_key;

-- Drop client_id column
ALTER TABLE vendors DROP COLUMN client_id;

-- Add new unique constraint on just name
ALTER TABLE vendors ADD CONSTRAINT vendors_name_key UNIQUE (name);

-- New RLS policies: vendors are readable by all, writable via service role
CREATE POLICY "vendors_read_all" ON vendors
  FOR SELECT USING (true);

CREATE POLICY "vendors_insert_all" ON vendors
  FOR INSERT WITH CHECK (true);

CREATE POLICY "vendors_delete_all" ON vendors
  FOR DELETE USING (true);

-- ============================================================
-- 5. Remove client_id from vendor_keywords table
-- ============================================================

-- Drop old RLS policies
DROP POLICY IF EXISTS "vendor_keywords_read_own" ON vendor_keywords;
DROP POLICY IF EXISTS "vendor_keywords_insert_own" ON vendor_keywords;
DROP POLICY IF EXISTS "vendor_keywords_delete_own" ON vendor_keywords;

-- Drop old index and constraint
DROP INDEX IF EXISTS idx_vendor_keywords_client;
ALTER TABLE vendor_keywords DROP CONSTRAINT IF EXISTS vendor_keywords_client_id_keyword_key;

-- Handle duplicate (vendor_id, keyword) rows before adding new constraint
-- Keep the first one created
DELETE FROM vendor_keywords a
USING vendor_keywords b
WHERE a.id > b.id
  AND a.vendor_id = b.vendor_id
  AND a.keyword = b.keyword;

-- Drop client_id column
ALTER TABLE vendor_keywords DROP COLUMN client_id;

-- Add new unique constraint
ALTER TABLE vendor_keywords ADD CONSTRAINT vendor_keywords_vendor_id_keyword_key UNIQUE (vendor_id, keyword);

-- New RLS policies: vendor keywords are readable by all
CREATE POLICY "vendor_keywords_read_all" ON vendor_keywords
  FOR SELECT USING (true);

CREATE POLICY "vendor_keywords_insert_all" ON vendor_keywords
  FOR INSERT WITH CHECK (true);

CREATE POLICY "vendor_keywords_delete_all" ON vendor_keywords
  FOR DELETE USING (true);

-- ============================================================
-- Done! Verify with:
-- SELECT * FROM vendors;
-- SELECT * FROM client_vendors;
-- SELECT * FROM vendor_keywords LIMIT 10;
-- ============================================================
