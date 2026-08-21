-- Migration v10: Global app settings (singleton row)
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  default_date_range VARCHAR(20) NOT NULL DEFAULT 'TODAY',
  default_impression_threshold INTEGER NOT NULL DEFAULT 0,
  default_mcc_account_id VARCHAR(20),
  cron_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT app_settings_singleton CHECK (id = 1)
);

-- Seed the single row if missing
INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Auto-update updated_at
DROP TRIGGER IF EXISTS app_settings_updated_at ON app_settings;
CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
