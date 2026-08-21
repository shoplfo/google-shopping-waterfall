-- Migration v6: Add MCC Account ID to clients
-- Run this in Supabase SQL Editor

ALTER TABLE clients ADD COLUMN IF NOT EXISTS mcc_account_id VARCHAR(20);

-- This is the Manager (MCC) account ID used as login-customer-id
-- when accessing child accounts via the Google Ads API.
-- Required when OAuth was done through an MCC account.
