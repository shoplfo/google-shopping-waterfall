-- ============================================================
-- Shopping Waterfall Engine — Database Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  google_ads_customer_id VARCHAR(20) NOT NULL, -- format: 123-456-7890
  oauth_refresh_token TEXT NOT NULL,
  campaign_prefix VARCHAR(100) NOT NULL, -- used in campaign naming convention
  is_active BOOLEAN NOT NULL DEFAULT true,
  impression_threshold INTEGER NOT NULL DEFAULT 0,
  date_range VARCHAR(20) NOT NULL DEFAULT 'TODAY', -- TODAY, YESTERDAY, LAST_7_DAYS
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- MASTER KEYWORDS (shared across all clients)
-- ============================================================
CREATE TABLE master_keywords (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  keyword VARCHAR(500) NOT NULL,
  category VARCHAR(100), -- e.g., "living room", "bedroom", "dining"
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(keyword)
);

-- ============================================================
-- VENDORS (global vendor/brand registry)
-- ============================================================
CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name)
);

-- ============================================================
-- CLIENT-VENDOR ASSIGNMENTS (many-to-many)
-- ============================================================
CREATE TABLE client_vendors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, vendor_id)
);

-- ============================================================
-- VENDOR KEYWORDS (belong to vendors, not clients)
-- ============================================================
CREATE TABLE vendor_keywords (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  keyword VARCHAR(500) NOT NULL,
  campaign_type VARCHAR(10) NOT NULL CHECK (campaign_type IN ('brand', 'product')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(vendor_id, keyword)
);

-- ============================================================
-- GENERAL NEGATIVES (universal blocklist for all clients)
-- ============================================================
CREATE TABLE general_negatives (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  keyword VARCHAR(500) NOT NULL,
  reason VARCHAR(500), -- why this term is blocked
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(keyword)
);

-- ============================================================
-- CAMPAIGN CONFIGS (which keyword sets each tier blocks)
-- ============================================================
CREATE TABLE campaign_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 3),
  campaign_name VARCHAR(500) NOT NULL,
  ad_group_name VARCHAR(500), -- optional: target specific ad group
  blocks_master BOOLEAN NOT NULL DEFAULT false,
  blocks_brand BOOLEAN NOT NULL DEFAULT false,
  blocks_product BOOLEAN NOT NULL DEFAULT false,
  google_campaign_id VARCHAR(50), -- cached Google Ads campaign ID
  google_ad_group_id VARCHAR(50), -- cached Google Ads ad group ID
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(client_id, tier)
);

-- ============================================================
-- RUN LOGS (audit trail of every engine execution)
-- ============================================================
CREATE TABLE run_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error', 'partial')),
  queries_processed INTEGER DEFAULT 0,
  queries_matched INTEGER DEFAULT 0,
  negatives_added INTEGER DEFAULT 0,
  general_negatives_added INTEGER DEFAULT 0,
  error_message TEXT,
  details_json JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- NEGATIVE KEYWORD HISTORY (track what was added and when)
-- ============================================================
CREATE TABLE negative_keyword_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  run_log_id UUID REFERENCES run_logs(id) ON DELETE SET NULL,
  search_query VARCHAR(1000) NOT NULL,
  campaign_name VARCHAR(500),
  ad_group_name VARCHAR(500),
  tier INTEGER,
  match_type VARCHAR(20) NOT NULL DEFAULT 'exact', -- exact, broad
  keyword_matched VARCHAR(500), -- which keyword it matched (if any)
  was_blocked BOOLEAN NOT NULL, -- true = added as negative, false = allowed through
  impressions INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES for performance
-- ============================================================
CREATE INDEX idx_client_vendors_client ON client_vendors(client_id);
CREATE INDEX idx_client_vendors_vendor ON client_vendors(vendor_id);
CREATE INDEX idx_vendor_keywords_vendor ON vendor_keywords(vendor_id);
CREATE INDEX idx_vendor_keywords_campaign_type ON vendor_keywords(campaign_type);
CREATE INDEX idx_campaign_configs_client ON campaign_configs(client_id);
CREATE INDEX idx_run_logs_client ON run_logs(client_id);
CREATE INDEX idx_run_logs_status ON run_logs(status);
CREATE INDEX idx_run_logs_started ON run_logs(started_at DESC);
CREATE INDEX idx_neg_history_client ON negative_keyword_history(client_id);
CREATE INDEX idx_neg_history_run ON negative_keyword_history(run_log_id);
CREATE INDEX idx_neg_history_created ON negative_keyword_history(created_at DESC);
CREATE INDEX idx_neg_history_blocked ON negative_keyword_history(was_blocked);

-- ============================================================
-- AUTO-UPDATE updated_at trigger
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY (for client dashboard access)
-- ============================================================
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE negative_keyword_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE general_negatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_configs ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS automatically.
-- These policies are for the anon/client-facing access:

-- Clients can read their own record
CREATE POLICY "clients_read_own" ON clients
  FOR SELECT USING (auth.uid()::text = id::text);

-- Clients can read master keywords
CREATE POLICY "master_keywords_read_all" ON master_keywords
  FOR SELECT USING (true);

-- Clients can read general negatives
CREATE POLICY "general_negatives_read_all" ON general_negatives
  FOR SELECT USING (true);

-- Vendors are readable/writable by all (managed via service role)
CREATE POLICY "vendors_read_all" ON vendors
  FOR SELECT USING (true);

CREATE POLICY "vendors_insert_all" ON vendors
  FOR INSERT WITH CHECK (true);

CREATE POLICY "vendors_delete_all" ON vendors
  FOR DELETE USING (true);

-- Client-vendor assignments: clients can manage their own
CREATE POLICY "client_vendors_read_own" ON client_vendors
  FOR SELECT USING (auth.uid()::text = client_id::text);

CREATE POLICY "client_vendors_insert_own" ON client_vendors
  FOR INSERT WITH CHECK (auth.uid()::text = client_id::text);

CREATE POLICY "client_vendors_delete_own" ON client_vendors
  FOR DELETE USING (auth.uid()::text = client_id::text);

-- Vendor keywords are readable/writable by all (managed via service role)
CREATE POLICY "vendor_keywords_read_all" ON vendor_keywords
  FOR SELECT USING (true);

CREATE POLICY "vendor_keywords_insert_all" ON vendor_keywords
  FOR INSERT WITH CHECK (true);

CREATE POLICY "vendor_keywords_delete_all" ON vendor_keywords
  FOR DELETE USING (true);

-- Clients can read their own run logs
CREATE POLICY "run_logs_read_own" ON run_logs
  FOR SELECT USING (auth.uid()::text = client_id::text);

-- Clients can read their own negative keyword history
CREATE POLICY "neg_history_read_own" ON negative_keyword_history
  FOR SELECT USING (auth.uid()::text = client_id::text);

-- Clients can read their own campaign configs
CREATE POLICY "campaign_configs_read_own" ON campaign_configs
  FOR SELECT USING (auth.uid()::text = client_id::text);

-- ============================================================
-- VIEWS for dashboard queries
-- ============================================================

-- Performance summary per client (last 30 days)
CREATE OR REPLACE VIEW client_performance_summary AS
SELECT
  c.id AS client_id,
  c.name AS client_name,
  c.is_active,
  COUNT(DISTINCT rl.id) AS total_runs_30d,
  COUNT(DISTINCT rl.id) FILTER (WHERE rl.status = 'success') AS successful_runs_30d,
  COUNT(DISTINCT rl.id) FILTER (WHERE rl.status = 'error') AS failed_runs_30d,
  COALESCE(SUM(rl.queries_processed), 0) AS total_queries_30d,
  COALESCE(SUM(rl.negatives_added), 0) AS total_negatives_30d,
  COALESCE(SUM(rl.general_negatives_added), 0) AS total_general_negatives_30d,
  MAX(rl.started_at) AS last_run_at,
  (SELECT status FROM run_logs WHERE client_id = c.id ORDER BY started_at DESC LIMIT 1) AS last_run_status
FROM clients c
LEFT JOIN run_logs rl ON rl.client_id = c.id AND rl.started_at > NOW() - INTERVAL '30 days'
GROUP BY c.id, c.name, c.is_active;

-- Daily stats for charting
CREATE OR REPLACE VIEW daily_stats AS
SELECT
  client_id,
  DATE(started_at) AS run_date,
  COUNT(*) AS runs,
  SUM(queries_processed) AS queries_processed,
  SUM(queries_matched) AS queries_matched,
  SUM(negatives_added) AS negatives_added,
  SUM(general_negatives_added) AS general_negatives_added,
  COUNT(*) FILTER (WHERE status = 'success') AS successful_runs,
  COUNT(*) FILTER (WHERE status = 'error') AS failed_runs
FROM run_logs
WHERE started_at > NOW() - INTERVAL '90 days'
GROUP BY client_id, DATE(started_at)
ORDER BY run_date DESC;

-- Global system health
CREATE OR REPLACE VIEW system_health AS
SELECT
  (SELECT COUNT(*) FROM clients WHERE is_active = true) AS active_clients,
  (SELECT COUNT(*) FROM master_keywords) AS master_keyword_count,
  (SELECT COUNT(*) FROM general_negatives) AS general_negative_count,
  (SELECT COUNT(*) FROM run_logs WHERE started_at > NOW() - INTERVAL '24 hours') AS runs_last_24h,
  (SELECT COUNT(*) FROM run_logs WHERE started_at > NOW() - INTERVAL '24 hours' AND status = 'error') AS errors_last_24h,
  (SELECT COALESCE(SUM(negatives_added), 0) FROM run_logs WHERE started_at > NOW() - INTERVAL '24 hours') AS negatives_added_24h,
  (SELECT COALESCE(SUM(queries_processed), 0) FROM run_logs WHERE started_at > NOW() - INTERVAL '24 hours') AS queries_processed_24h;
