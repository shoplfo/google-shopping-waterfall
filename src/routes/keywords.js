const express = require('express');
const router = express.Router();
const { supabase } = require('../db');
const { normalize } = require('../engine/matcher');
const {
  createAdsClient,
  syncMasterNegativesForClient,
  syncVendorNegatives,
  formatGoogleAdsError,
} = require('../engine/googleAds');
const { requirePermission } = require('../middleware/auth');

// ============================================================
// MASTER KEYWORDS
// ============================================================

// GET /api/keywords/master — List all master keywords
router.get('/master', async (req, res) => {
  try {
    const { category, search } = req.query;
    let query = supabase.from('master_keywords').select('*').order('keyword');

    if (category) query = query.eq('category', category);
    if (search) query = query.ilike('keyword', `%${search}%`);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/keywords/master/categories — List unique categories
router.get('/master/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('master_keywords')
      .select('category')
      .not('category', 'is', null)
      .order('category');

    if (error) throw error;
    const categories = [...new Set(data.map(d => d.category))];
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keywords/master — Add master keyword(s)
router.post('/master', async (req, res) => {
  try {
    const { keywords } = req.body; // Array of { keyword, category? }

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'Provide an array of keywords: [{ keyword, category? }]' });
    }

    const normalized = keywords.map(k => ({
      keyword: normalize(k.keyword || k),
      category: k.category || null,
    }));

    const { data, error } = await supabase
      .from('master_keywords')
      .upsert(normalized, { onConflict: 'keyword' })
      .select();

    if (error) throw error;
    res.status(201).json({ added: data.length, keywords: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/keywords/master/import — Bulk import from CSV text
router.post('/master/import', async (req, res) => {
  try {
    const { csv, category } = req.body; // csv = "keyword1\nkeyword2\nkeyword3"

    if (!csv) return res.status(400).json({ error: 'Provide csv field with one keyword per line' });

    const lines = csv.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const normalized = lines.map(keyword => ({
      keyword: normalize(keyword),
      category: category || null,
    }));

    const { data, error } = await supabase
      .from('master_keywords')
      .upsert(normalized, { onConflict: 'keyword' })
      .select();

    if (error) throw error;
    res.status(201).json({ imported: data.length, keywords: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/keywords/master/:id — Remove master keyword
router.delete('/master/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('master_keywords')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ message: 'Master keyword deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GENERAL NEGATIVES
// ============================================================

// GET /api/keywords/negatives — List general negatives
router.get('/negatives', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('general_negatives')
      .select('*')
      .order('keyword');

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const ALLOWED_MATCH_TYPES = ['exact', 'phrase', 'broad'];

// POST /api/keywords/negatives — Add general negative(s)
router.post('/negatives', async (req, res) => {
  try {
    const { keywords } = req.body; // Array of { keyword, reason?, match_type? } or bare strings

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'Provide an array of keywords: [{ keyword, reason?, match_type? }]' });
    }

    const normalized = [];
    for (const k of keywords) {
      const keyword = normalize(typeof k === 'string' ? k : k.keyword);
      if (!keyword) continue;
      const match_type = (typeof k === 'object' && k.match_type) ? String(k.match_type).toLowerCase() : 'phrase';
      if (!ALLOWED_MATCH_TYPES.includes(match_type)) {
        return res.status(400).json({ error: `Invalid match_type "${match_type}". Allowed: ${ALLOWED_MATCH_TYPES.join(', ')}` });
      }
      normalized.push({
        keyword,
        reason: (typeof k === 'object' ? k.reason : null) || null,
        match_type,
      });
    }

    const { data, error } = await supabase
      .from('general_negatives')
      .upsert(normalized, { onConflict: 'keyword' })
      .select();

    if (error) throw error;
    res.status(201).json({ added: data.length, keywords: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/keywords/negatives/:id — Update a general negative (e.g. change match_type)
router.patch('/negatives/:id', async (req, res) => {
  try {
    const updates = {};
    if (req.body.match_type !== undefined) {
      const mt = String(req.body.match_type).toLowerCase();
      if (!ALLOWED_MATCH_TYPES.includes(mt)) {
        return res.status(400).json({ error: `Invalid match_type. Allowed: ${ALLOWED_MATCH_TYPES.join(', ')}` });
      }
      updates.match_type = mt;
    }
    if (req.body.reason !== undefined) updates.reason = req.body.reason || null;

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields provided.' });

    const { data, error } = await supabase
      .from('general_negatives')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/keywords/negatives/:id — Remove general negative
router.delete('/negatives/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('general_negatives')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ message: 'General negative deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// KEYWORD STATS (for dashboard)
// ============================================================

// GET /api/keywords/stats — Counts of all keyword types
router.get('/stats', async (req, res) => {
  try {
    const [masterRes, vendorRes, negRes] = await Promise.all([
      supabase.from('master_keywords').select('id', { count: 'exact', head: true }),
      supabase.from('vendor_keywords').select('id', { count: 'exact', head: true }),
      supabase.from('general_negatives').select('id', { count: 'exact', head: true }),
    ]);

    res.json({
      master_keywords: masterRes.count || 0,
      vendor_keywords: vendorRes.count || 0,
      general_negatives: negRes.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export stats handler separately for mounting before permission wall
const statsHandler = async (req, res) => {
  try {
    const [masterRes, vendorRes, negRes] = await Promise.all([
      supabase.from('master_keywords').select('id', { count: 'exact', head: true }),
      supabase.from('vendor_keywords').select('id', { count: 'exact', head: true }),
      supabase.from('general_negatives').select('id', { count: 'exact', head: true }),
    ]);

    res.json({
      master_keywords: masterRes.count || 0,
      vendor_keywords: vendorRes.count || 0,
      general_negatives: negRes.count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * POST /api/keywords/negatives/sync-all
 * Loops every active client and pushes the current general_negatives list to
 * their master SharedSet (idempotent diff-add/remove). Returns a per-client
 * report so the dashboard can show exactly who succeeded and who errored.
 */
router.post('/negatives/sync-all', requirePermission('manage_general_negatives'), async (req, res) => {
  try {
    const { data: negs, error: negErr } = await supabase
      .from('general_negatives')
      .select('keyword, match_type');
    if (negErr) throw negErr;

    const { data: clients, error: cliErr } = await supabase
      .from('clients')
      .select('id, name, google_ads_customer_id, oauth_refresh_token, mcc_account_id, master_shared_set_resource_name')
      .eq('is_active', true);
    if (cliErr) throw cliErr;

    const results = [];
    for (const client of (clients || [])) {
      if (!client.oauth_refresh_token) {
        results.push({ clientId: client.id, name: client.name, status: 'skipped', reason: 'No OAuth token — not connected to Google Ads' });
        continue;
      }

      const customerId = client.google_ads_customer_id.replace(/-/g, '');
      const mccId = client.mcc_account_id || null;
      let customer = createAdsClient(client.oauth_refresh_token, customerId, mccId);
      if (mccId) {
        try { await customer.query(`SELECT campaign.id FROM campaign LIMIT 1`); }
        catch (_) { customer = createAdsClient(client.oauth_refresh_token, customerId, null); }
      }

      try {
        // Load this client's vendor rows + all campaign configs
        const [cvRowsRes, allConfigsRes] = await Promise.all([
          supabase
            .from('client_vendors')
            .select('id, vendor_id, vendors(id, name)')
            .eq('client_id', client.id),
          supabase
            .from('campaign_configs')
            .select('google_campaign_id, vendor_id, blocks_brand, blocks_product')
            .eq('client_id', client.id)
            .not('google_campaign_id', 'is', null),
        ]);

        const allCampaignIds = [...new Set((allConfigsRes.data || []).map(c => c.google_campaign_id))];

        // 1. Master Negatives (SharedSet, client-wide) — self-heals if deleted in Ads UI
        const masterResult = await syncMasterNegativesForClient(
          customer, customerId, client, negs || [], allCampaignIds
        );

        // 2. Per-vendor Brand + Product — direct CampaignCriterion negatives
        const vendorResults = [];
        for (const cv of (cvRowsRes.data || [])) {
          const vendorName = cv.vendors?.name || 'vendor';
          const vendorConfigs = (allConfigsRes.data || []).filter(c => c.vendor_id === cv.vendor_id);

          const [brandRes, productRes] = await Promise.all([
            supabase.from('vendor_keywords').select('keyword').eq('campaign_type', 'brand').eq('is_active', true).eq('vendor_id', cv.vendor_id),
            supabase.from('vendor_keywords').select('keyword').eq('campaign_type', 'product').eq('is_active', true).eq('vendor_id', cv.vendor_id),
          ]);

          const brandKeywords = (brandRes.data || []).map(r => ({ keyword: r.keyword, match_type: 'broad' }));
          const productKeywords = (productRes.data || []).map(r => ({ keyword: r.keyword, match_type: 'broad' }));

          const vr = await syncVendorNegatives(
            customer, customerId, vendorName, brandKeywords, productKeywords, vendorConfigs
          );

          await supabase.from('client_vendors')
            .update({ master_negatives_synced_at: new Date().toISOString() })
            .eq('id', cv.id);

          vendorResults.push({ vendor: vendorName, brand: vr.brand, product: vr.product });
        }

        // Persist client-level state
        const clientUpdates = { master_negatives_synced_at: new Date().toISOString() };
        if (masterResult.resourceName && masterResult.resourceName !== client.master_shared_set_resource_name) {
          clientUpdates.master_shared_set_resource_name = masterResult.resourceName;
        }
        await supabase.from('clients').update(clientUpdates).eq('id', client.id);

        results.push({
          clientId: client.id,
          name: client.name,
          status: 'ok',
          general: masterResult,
          vendors: vendorResults,
        });
      } catch (err) {
        const detail = formatGoogleAdsError(err);
        results.push({ clientId: client.id, name: client.name, status: 'error', error: detail });
      }
    }

    const okCount = results.filter(r => r.status === 'ok').length;
    const errorCount = results.filter(r => r.status === 'error').length;
    const skippedCount = results.filter(r => r.status === 'skipped').length;

    res.json({
      total: results.length,
      ok: okCount,
      errors: errorCount,
      skipped: skippedCount,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.statsHandler = statsHandler;
