-- Migration V5: Per-vendor campaign creation support
-- Run in Supabase SQL Editor

-- 1. Add merchant_id to clients
ALTER TABLE clients ADD COLUMN IF NOT EXISTS merchant_id VARCHAR(20);

-- 2. Add vendor_id and google_budget_id to campaign_configs
ALTER TABLE campaign_configs ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id) ON DELETE CASCADE;
ALTER TABLE campaign_configs ADD COLUMN IF NOT EXISTS google_budget_id VARCHAR(50);

-- 3. Drop old unique constraint and add new one
ALTER TABLE campaign_configs DROP CONSTRAINT IF EXISTS campaign_configs_client_id_tier_key;
ALTER TABLE campaign_configs ADD CONSTRAINT campaign_configs_client_vendor_tier_key
  UNIQUE(client_id, vendor_id, tier);

-- 4. Index on vendor_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_campaign_configs_vendor ON campaign_configs(vendor_id);

-- 5. Track campaign creation status on client_vendors
ALTER TABLE client_vendors ADD COLUMN IF NOT EXISTS campaigns_created BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE client_vendors ADD COLUMN IF NOT EXISTS campaigns_created_at TIMESTAMPTZ;
