-- Migration v15: Persist Brand + Product keyword SharedSet resource names per client.
-- Master negatives SharedSet already has master_shared_set_resource_name. Adding
-- parallel columns for the two new SharedSets that sync now also creates and
-- attaches according to the waterfall:
--   Brand Keywords SharedSet    → attached to campaigns where blocks_brand=TRUE (Product tier)
--   Product Keywords SharedSet  → attached to campaigns where blocks_product=TRUE (Brand tier)
-- Run in Supabase SQL Editor

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS brand_shared_set_resource_name VARCHAR(200);

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS product_shared_set_resource_name VARCHAR(200);
