-- Migration v14: Per-vendor master-negatives sync timestamp
-- Master negatives live in one SharedSet per client, but the SharedSet is
-- *attached* to campaigns on a per-vendor basis. Track the last attach-sync
-- time per vendor-assignment so the dashboard can show vendor-level sync state.
-- Run in Supabase SQL Editor

ALTER TABLE client_vendors
  ADD COLUMN IF NOT EXISTS master_negatives_synced_at TIMESTAMPTZ;
