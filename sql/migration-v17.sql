-- Migration v17: Move Brand/Product negatives to campaign level
-- Brand + Product keyword lists are moving off SharedSets onto direct
-- CampaignCriterion negatives (campaign_criterion with negative=TRUE).
-- This removes the 1000-per-mutate SharedSet ceiling we kept hitting on
-- large vendors like Ashley (~3000 keywords) and the 5000/SharedSet cap.
-- After this, each vendor campaign directly owns its negatives
-- (Google allows up to 10,000 per campaign).
--
-- Master/General Negatives stays a SharedSet — it IS shared across all
-- 3×N campaigns per client, so the indirection is justified there.
--
-- Run in Supabase SQL Editor

ALTER TABLE public.client_vendors
  DROP COLUMN IF EXISTS brand_shared_set_resource_name;

ALTER TABLE public.client_vendors
  DROP COLUMN IF EXISTS product_shared_set_resource_name;

-- Note: Existing per-vendor SharedSets in Google Ads (named
--   '{PREFIX} | {Vendor} | Brand' and '{PREFIX} | {Vendor} | Product')
-- become orphans after this migration. The code no longer references them.
-- Delete them manually via Google Ads UI → Tools → Shared library →
-- Negative keyword lists.
