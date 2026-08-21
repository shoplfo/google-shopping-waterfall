-- ============================================================
-- Migration V2: Vendor Keywords Restructure + Tier Renaming
-- Run this in Supabase SQL Editor
-- ============================================================

-- ============================================================
-- 1. Create vendors table (per-client)
-- ============================================================
CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, name)
);

CREATE INDEX idx_vendors_client ON vendors(client_id);

ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vendors_read_own" ON vendors
  FOR SELECT USING (auth.uid()::text = client_id::text);

CREATE POLICY "vendors_insert_own" ON vendors
  FOR INSERT WITH CHECK (auth.uid()::text = client_id::text);

CREATE POLICY "vendors_delete_own" ON vendors
  FOR DELETE USING (auth.uid()::text = client_id::text);

-- ============================================================
-- 2. Migrate existing vendor_name data into vendors table
-- ============================================================
INSERT INTO vendors (client_id, name)
SELECT DISTINCT client_id, vendor_name
FROM vendor_keywords
WHERE vendor_name IS NOT NULL AND vendor_name != ''
ON CONFLICT (client_id, name) DO NOTHING;

-- Create a "General" vendor for any client that has vendor keywords with NULL vendor_name
INSERT INTO vendors (client_id, name)
SELECT DISTINCT client_id, 'General'
FROM vendor_keywords
WHERE vendor_name IS NULL OR vendor_name = ''
ON CONFLICT (client_id, name) DO NOTHING;

-- ============================================================
-- 3. Alter vendor_keywords table
-- ============================================================

-- Add new columns
ALTER TABLE vendor_keywords ADD COLUMN vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE;
ALTER TABLE vendor_keywords ADD COLUMN campaign_type VARCHAR(10) NOT NULL DEFAULT 'brand' CHECK (campaign_type IN ('brand', 'product'));

-- Backfill vendor_id from vendors table
UPDATE vendor_keywords vk
SET vendor_id = v.id
FROM vendors v
WHERE v.client_id = vk.client_id AND v.name = vk.vendor_name;

-- Backfill NULL vendor_name rows with the "General" vendor
UPDATE vendor_keywords vk
SET vendor_id = v.id
FROM vendors v
WHERE v.client_id = vk.client_id
  AND v.name = 'General'
  AND (vk.vendor_name IS NULL OR vk.vendor_name = '');

-- Make vendor_id required
ALTER TABLE vendor_keywords ALTER COLUMN vendor_id SET NOT NULL;

-- Drop old vendor_name column
ALTER TABLE vendor_keywords DROP COLUMN vendor_name;

-- Add indexes
CREATE INDEX idx_vendor_keywords_vendor ON vendor_keywords(vendor_id);
CREATE INDEX idx_vendor_keywords_campaign_type ON vendor_keywords(campaign_type);

-- ============================================================
-- 4. Alter campaign_configs table
-- ============================================================

-- Add new blocking columns
ALTER TABLE campaign_configs ADD COLUMN blocks_brand BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE campaign_configs ADD COLUMN blocks_product BOOLEAN NOT NULL DEFAULT false;

-- Migrate existing data:
-- Tier 1 (General): blocks nothing
UPDATE campaign_configs SET blocks_brand = false, blocks_product = false WHERE tier = 1;
-- Tier 2 (Brand): blocks master + product vendor keywords
UPDATE campaign_configs SET blocks_brand = false, blocks_product = true WHERE tier = 2;
-- Tier 3 (Product): blocks master + brand vendor keywords
UPDATE campaign_configs SET blocks_brand = true, blocks_product = false WHERE tier = 3;

-- Rename campaign names from Tier N to General/Brand/Product
UPDATE campaign_configs SET campaign_name = REPLACE(campaign_name, 'Tier 1', 'General') WHERE tier = 1;
UPDATE campaign_configs SET campaign_name = REPLACE(campaign_name, 'Tier 2', 'Brand') WHERE tier = 2;
UPDATE campaign_configs SET campaign_name = REPLACE(campaign_name, 'Tier 3', 'Product') WHERE tier = 3;

-- Drop old column
ALTER TABLE campaign_configs DROP COLUMN blocks_vendor;

-- ============================================================
-- Done! Verify with:
-- SELECT * FROM vendors;
-- SELECT * FROM vendor_keywords LIMIT 10;
-- SELECT * FROM campaign_configs;
-- ============================================================
