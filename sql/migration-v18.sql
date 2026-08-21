-- Migration v18: Configurable campaign name prefix + Merchant Center feed label
--
-- Two values used to be hardcoded to a single advertiser's setup:
--   1. Every campaign name started with a fixed prefix
--   2. Every Shopping campaign was created with feed_label 'US'
-- Both are now global settings, so any advertiser in any country can run this.
--
-- Run in the Supabase SQL Editor.

-- First segment of every generated name:
--   "{campaign_name_prefix} | {Vendor} | Shopping | {General|Brand|Product}"
-- Cannot contain '|' — that character separates the name's fields.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS campaign_name_prefix VARCHAR(40) NOT NULL DEFAULT 'ADS';

-- Merchant Center feed label applied to newly created Shopping campaigns.
-- NULL = omit it entirely and let Google use the account default.
-- Typical values: 'US', 'GB', 'CA', 'AU', 'DE', or a custom feed label.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS default_feed_label VARCHAR(40) DEFAULT 'US';

-- ---------------------------------------------------------------------------
-- ALREADY HAVE CAMPAIGNS?
-- If this account has campaigns created before this migration, set the prefix
-- to whatever they already use so new campaigns keep matching:
--
--   UPDATE public.app_settings SET campaign_name_prefix = 'YOUR PREFIX' WHERE id = 1;
--
-- You can also set it from the dashboard: Settings -> Campaign Name Prefix.
--
-- Either way this only affects campaigns created AFTER the change. Campaigns
-- that already exist in Google Ads keep the name they were created with.
-- ---------------------------------------------------------------------------
