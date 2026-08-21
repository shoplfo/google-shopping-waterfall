const express = require('express');
const router = express.Router();
const { supabase } = require('../db');
const { requirePermission } = require('../middleware/auth');
const { clearPrefixCache, DEFAULT_PREFIX } = require('../naming');

const ALLOWED_DATE_RANGES = ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS'];

/**
 * Load the singleton app_settings row. Returns null on not-found/error.
 */
async function loadSettings() {
  const { data, error } = await supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// GET /api/settings — Read global app settings (admin only)
router.get('/', requirePermission('view_settings'), async (req, res) => {
  try {
    let settings = await loadSettings();
    if (!settings) {
      // Singleton was not seeded — create it on first read
      const { data, error } = await supabase
        .from('app_settings')
        .insert({ id: 1 })
        .select('*')
        .single();
      if (error) throw error;
      settings = data;
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings — Update global app settings (admin only)
router.put('/', requirePermission('view_settings'), async (req, res) => {
  try {
    const { default_date_range, default_impression_threshold, default_mcc_account_id, cron_enabled, default_observation_audiences, default_block_mobile_apps, mobile_app_category_id, campaign_name_prefix, default_feed_label } = req.body;

    const updates = {};
    if (default_date_range !== undefined) {
      if (!ALLOWED_DATE_RANGES.includes(default_date_range)) {
        return res.status(400).json({ error: `Invalid date range. Allowed: ${ALLOWED_DATE_RANGES.join(', ')}` });
      }
      updates.default_date_range = default_date_range;
    }
    if (default_impression_threshold !== undefined) {
      const n = parseInt(default_impression_threshold, 10);
      if (Number.isNaN(n) || n < 0) {
        return res.status(400).json({ error: 'default_impression_threshold must be a non-negative integer' });
      }
      updates.default_impression_threshold = n;
    }
    if (default_mcc_account_id !== undefined) {
      updates.default_mcc_account_id = default_mcc_account_id || null;
    }
    if (campaign_name_prefix !== undefined) {
      const prefix = String(campaign_name_prefix || '').trim();
      if (!prefix) {
        return res.status(400).json({ error: 'campaign_name_prefix cannot be empty' });
      }
      if (prefix.length > 40) {
        return res.status(400).json({ error: 'campaign_name_prefix must be 40 characters or fewer' });
      }
      // '|' is the field separator in generated campaign names — allowing it
      // inside the prefix would make names ambiguous to parse.
      if (prefix.includes('|')) {
        return res.status(400).json({ error: 'campaign_name_prefix cannot contain the "|" character' });
      }
      updates.campaign_name_prefix = prefix;
    }
    if (default_feed_label !== undefined) {
      const label = String(default_feed_label || '').trim();
      if (label.length > 40) {
        return res.status(400).json({ error: 'default_feed_label must be 40 characters or fewer' });
      }
      updates.default_feed_label = label || null;
    }
    if (cron_enabled !== undefined) {
      updates.cron_enabled = !!cron_enabled;
    }
    if (default_block_mobile_apps !== undefined) {
      updates.default_block_mobile_apps = !!default_block_mobile_apps;
    }
    if (mobile_app_category_id !== undefined) {
      const cat = String(mobile_app_category_id).trim();
      if (!/^\d+$/.test(cat)) {
        return res.status(400).json({ error: 'mobile_app_category_id must be a numeric string (e.g. "69500")' });
      }
      updates.mobile_app_category_id = cat;
    }
    if (default_observation_audiences !== undefined) {
      if (!Array.isArray(default_observation_audiences)) {
        return res.status(400).json({ error: 'default_observation_audiences must be an array of audience criterion ID strings' });
      }
      // Normalize to trimmed strings of digits only (in-market audience criterion IDs are numeric)
      const cleaned = default_observation_audiences
        .map(a => String(a).trim())
        .filter(a => /^\d+$/.test(a));
      updates.default_observation_audiences = cleaned;
    }

    if (req.session?.userId) {
      updates.updated_by = req.session.userId;
    }

    const { data, error } = await supabase
      .from('app_settings')
      .update(updates)
      .eq('id', 1)
      .select('*')
      .single();

    if (error) throw error;

    // Naming cache holds the prefix for up to 30s — drop it so the change
    // takes effect on the very next campaign build.
    if (updates.campaign_name_prefix !== undefined) clearPrefixCache();

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.loadSettings = loadSettings;
