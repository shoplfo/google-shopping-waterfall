-- Migration v16: Per-vendor Brand/Product SharedSets
-- Each vendor now has its own Brand + Product keyword SharedSet, named
-- "{PREFIX} | {Vendor} | Brand" and "{PREFIX} | {Vendor} | Product". Master
-- Negatives remain client-wide (stays on clients.master_shared_set_resource_name).
-- Run in Supabase SQL Editor

ALTER TABLE client_vendors
  ADD COLUMN IF NOT EXISTS brand_shared_set_resource_name VARCHAR(200);

ALTER TABLE client_vendors
  ADD COLUMN IF NOT EXISTS product_shared_set_resource_name VARCHAR(200);

-- Retire the client-level Brand/Product columns (added in v15, never persisted
-- successful data because the vendor_keywords join was broken).
ALTER TABLE clients
  DROP COLUMN IF EXISTS brand_shared_set_resource_name;

ALTER TABLE clients
  DROP COLUMN IF EXISTS product_shared_set_resource_name;
