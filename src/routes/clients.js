const express = require('express');
const router = express.Router();
const { supabase } = require('../db');
const { createVendorCampaigns, createAllVendorCampaigns, TIER_CONFIG } = require('../engine/campaignManager');
const {
  createAdsClient,
  applyObservationAudiences,
  getUrlTrackingIssues,
  ensureMobileAppBlock,
  syncMasterNegativesForClient,
  rebuildMasterSharedSet,
  syncVendorNegatives,
} = require('../engine/googleAds');
const { requirePermission } = require('../middleware/auth');
const { getCampaignPrefix, campaignName: buildCampaignName } = require('../naming');
const { loadSettings } = require('./settings');

/**
 * Helper: check if a client ID is within the user's scope.
 * Returns true if unscoped (admin/account_manager) or if clientId is in the allowed list.
 */
function isInScope(req, clientId) {
  if (!req.clientScope || !req.clientScope.scoped) return true;
  return (req.clientScope.clientIds || []).includes(clientId);
}

// GET /api/clients — List clients (scoped by role)
router.get('/', async (req, res) => {
  try {
    let query = supabase
      .from('clients')
      .select('id, name, google_ads_customer_id, campaign_prefix, is_active, impression_threshold, date_range, oauth_refresh_token, merchant_id, mcc_account_id, master_shared_set_resource_name, block_mobile_apps, mobile_apps_blocked_at, master_negatives_synced_at, created_at, updated_at')
      .order('name');

    // Scope: client/agency only see assigned clients
    if (req.clientScope && req.clientScope.scoped) {
      const ids = req.clientScope.clientIds || [];
      if (ids.length === 0) return res.json([]);
      query = query.in('id', ids);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json(data.map(c => {
      const has_refresh_token = !!c.oauth_refresh_token && c.oauth_refresh_token.length > 0;
      const { oauth_refresh_token, ...rest } = c;
      return { ...rest, has_refresh_token };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id — Get single client (scope-checked)
router.get('/:id', async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden: client not in your scope' });
    }

    const { data, error } = await supabase
      .from('clients')
      .select('id, name, google_ads_customer_id, campaign_prefix, is_active, impression_threshold, date_range, oauth_refresh_token, merchant_id, mcc_account_id, master_shared_set_resource_name, block_mobile_apps, mobile_apps_blocked_at, master_negatives_synced_at, created_at, updated_at')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Client not found' });
    const has_refresh_token = !!data.oauth_refresh_token && data.oauth_refresh_token.length > 0;
    const { oauth_refresh_token, ...rest } = data;
    res.json({ ...rest, has_refresh_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients — Create a new client (agency+)
router.post('/', requirePermission('create_client'), async (req, res) => {
  try {
    const { name, google_ads_customer_id, oauth_refresh_token, campaign_prefix, merchant_id, mcc_account_id, impression_threshold, date_range } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Missing required field: name' });
    }

    // Load global defaults to fill in any unspecified values
    const settings = await loadSettings().catch(() => null);

    const { data, error } = await supabase
      .from('clients')
      .insert({
        name,
        google_ads_customer_id: google_ads_customer_id || '',
        oauth_refresh_token: oauth_refresh_token || '',
        campaign_prefix: campaign_prefix || '',
        merchant_id: merchant_id || null,
        mcc_account_id: mcc_account_id || settings?.default_mcc_account_id || null,
        impression_threshold: impression_threshold ?? settings?.default_impression_threshold ?? 0,
        date_range: date_range || settings?.default_date_range || 'TODAY',
      })
      .select('id, name, google_ads_customer_id, campaign_prefix, merchant_id, is_active, created_at')
      .single();

    if (error) throw error;

    // Auto-assign client to agency user who created it
    if (req.session?.userRole === 'agency' && req.session?.userId) {
      await supabase.from('user_clients').insert({
        user_id: req.session.userId,
        client_id: data.id,
      });
    }

    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id — Update client (agency+ with scope check)
router.patch('/:id', requirePermission('edit_client'), async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden: client not in your scope' });
    }

    const allowed = ['name', 'google_ads_customer_id', 'oauth_refresh_token', 'campaign_prefix', 'merchant_id', 'mcc_account_id', 'is_active', 'impression_threshold', 'date_range', 'block_mobile_apps'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data, error } = await supabase
      .from('clients')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, google_ads_customer_id, campaign_prefix, merchant_id, is_active, impression_threshold, date_range, updated_at')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Client not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id/archive — Archive (deactivate) a client (agency+ with scope)
router.patch('/:id/archive', requirePermission('edit_client'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('clients')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .select('id, name, is_active')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client archived', client: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id — Permanently delete a client (admin only, requires confirm_name)
router.delete('/:id', requirePermission('manage_users'), async (req, res) => {
  try {
    const { confirm_name } = req.body;

    // Look up the client first
    const { data: client, error: lookupError } = await supabase
      .from('clients')
      .select('id, name')
      .eq('id', req.params.id)
      .single();

    if (lookupError) throw lookupError;
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Require exact name match to confirm deletion
    if (!confirm_name || confirm_name !== client.name) {
      return res.status(400).json({ error: 'Type the exact client name to confirm deletion.' });
    }

    // Delete (cascades to client_vendors, campaign_configs, run_logs, negative_keyword_history)
    const { error } = await supabase
      .from('clients')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ message: `Client "${client.name}" permanently deleted.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CLIENT-VENDOR ASSIGNMENTS
// ============================================================

// GET /api/clients/:id/vendors — List vendors assigned to this client (scope-checked)
router.get('/:id/vendors', async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) {
      return res.status(403).json({ error: 'Forbidden: client not in your scope' });
    }
    const { data, error } = await supabase
      .from('client_vendors')
      .select('id, vendor_id, created_at, campaigns_created, campaigns_created_at, master_negatives_synced_at, vendors(id, name)')
      .eq('client_id', req.params.id)
      .order('created_at');

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/vendors — Assign a vendor to this client (agency+)
router.post('/:id/vendors', requirePermission('assign_vendors'), async (req, res) => {
  try {
    const { vendor_id } = req.body;
    if (!vendor_id) {
      return res.status(400).json({ error: 'vendor_id is required' });
    }

    const { data, error } = await supabase
      .from('client_vendors')
      .upsert({ client_id: req.params.id, vendor_id }, { onConflict: 'client_id,vendor_id' })
      .select('id, vendor_id, created_at, vendors(id, name)')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id/vendors/:vendorId — Unassign a vendor (agency+)
router.delete('/:id/vendors/:vendorId', requirePermission('assign_vendors'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('client_vendors')
      .delete()
      .eq('client_id', req.params.id)
      .eq('vendor_id', req.params.vendorId);

    if (error) throw error;
    res.json({ message: 'Vendor unassigned from client' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CAMPAIGN CREATION
// ============================================================

// POST /api/clients/:id/campaigns/create — Create campaigns for all vendors (account_manager+)
router.post('/:id/campaigns/create', requirePermission('create_campaigns'), async (req, res) => {
  try {
    const budget = parseInt(req.body.budget) || 50;
    const result = await createAllVendorCampaigns(req.params.id, budget);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/vendors/:vendorId/campaigns/create — Create campaigns for one vendor (account_manager+)
router.post('/:id/vendors/:vendorId/campaigns/create', requirePermission('create_campaigns'), async (req, res) => {
  try {
    const budget = parseInt(req.body.budget) || 50;
    const result = await createVendorCampaigns(req.params.id, req.params.vendorId, budget);
    res.json(result);
  } catch (err) {
    const msg = err.message || 'Unknown error';
    const status = msg.includes('not found') ? 404
      : msg.includes('already created') ? 409
      : msg.includes('no ') ? 400
      : 500;
    res.status(status).json({ error: msg, details: err.errors || undefined });
  }
});

// ============================================================
// TEST CONNECTION
// ============================================================

// POST /api/clients/:id/campaigns/test — Test Google Ads API connection (account_manager+)
router.post('/:id/campaigns/test', requirePermission('create_campaigns'), async (req, res) => {
  try {
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, name, google_ads_customer_id, oauth_refresh_token, merchant_id, mcc_account_id')
      .eq('id', req.params.id)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client not found' });
    if (!client.oauth_refresh_token) return res.json({ connected: false, error: 'No OAuth token' });
    if (!client.google_ads_customer_id) return res.json({ connected: false, error: 'No Customer ID' });

    const customerId = client.google_ads_customer_id.replace(/-/g, '');
    const mccId = client.mcc_account_id || null;

    // Try with MCC first (if set), then without MCC as fallback
    const attempts = mccId ? [mccId, null] : [null];
    let result = { connected: true, customerId, mccAccountId: mccId, reads: false, writes: false };

    for (const loginId of attempts) {
      const customer = createAdsClient(client.oauth_refresh_token, customerId, loginId);
      result.usedMcc = loginId || 'direct';

      // Test read
      try {
        const campaigns = await customer.query(`SELECT campaign.id, campaign.name FROM campaign LIMIT 5`);
        result.reads = true;
        result.campaignCount = campaigns.length;
        result.sampleCampaigns = campaigns.slice(0, 3).map(c => ({ id: c.campaign.id?.toString(), name: c.campaign.name }));
      } catch (e) {
        result.readError = e.message;
        // If MCC attempt failed, try direct
        if (loginId && attempts.length > 1) continue;
      }

      // Test write (create + immediately remove a test budget)
      try {
        const budgetRes = await customer.campaignBudgets.create([{
          name: `_test_budget_${Date.now()}`,
          amount_micros: 1000000,
          delivery_method: 2,
        }]);
        const budgetRN = budgetRes.results[0].resource_name;
        result.writes = true;
        // Clean up: remove the test budget
        try {
          await customer.campaignBudgets.remove([budgetRN]);
        } catch (_) { /* best effort cleanup */ }
      } catch (e) {
        result.writeError = e.message;
        if (e.errors) result.writeErrorDetails = e.errors;
      }

      // If reads worked, stop trying
      if (result.reads) break;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CSV EXPORT
// ============================================================

// GET /api/clients/:id/campaigns/csv — Download CSV for all vendors without campaigns (account_manager+)
router.get('/:id/campaigns/csv', requirePermission('create_campaigns'), async (req, res) => {
  try {
    const budget = parseInt(req.query.budget) || 50;

    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('id, name, merchant_id')
      .eq('id', req.params.id)
      .single();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });
    if (!client.merchant_id) return res.status(400).json({ error: 'Client has no Merchant Center ID' });

    const { data: vendors, error: vendorErr } = await supabase
      .from('client_vendors')
      .select('vendor_id, campaigns_created, vendors(id, name)')
      .eq('client_id', req.params.id)
      .eq('campaigns_created', false);
    if (vendorErr) throw vendorErr;
    if (!vendors.length) return res.status(400).json({ error: 'All vendors already have campaigns' });

    const { generateEditorCSV } = require('../engine/csvExporter');
    const vendorConfigs = vendors.map(v => ({
      vendorName: v.vendors.name,
      merchantId: client.merchant_id,
    }));

    const csv = generateEditorCSV(vendorConfigs, budget, await getCampaignPrefix());
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${client.name.replace(/[^a-z0-9]/gi, '_')}_campaigns.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id/vendors/:vendorId/campaigns/csv — Download CSV for one vendor (account_manager+)
router.get('/:id/vendors/:vendorId/campaigns/csv', requirePermission('create_campaigns'), async (req, res) => {
  try {
    const budget = parseInt(req.query.budget) || 50;

    const { data: client, error: clientErr } = await supabase
      .from('clients')
      .select('id, name, merchant_id')
      .eq('id', req.params.id)
      .single();
    if (clientErr || !client) return res.status(404).json({ error: 'Client not found' });
    if (!client.merchant_id) return res.status(400).json({ error: 'Client has no Merchant Center ID' });

    const { data: cv, error: cvErr } = await supabase
      .from('client_vendors')
      .select('vendor_id, campaigns_created, vendors(id, name)')
      .eq('client_id', req.params.id)
      .eq('vendor_id', req.params.vendorId)
      .single();
    if (cvErr || !cv) return res.status(404).json({ error: 'Vendor not assigned to client' });
    if (cv.campaigns_created) return res.status(400).json({ error: 'Campaigns already created for this vendor' });

    const { generateEditorCSV } = require('../engine/csvExporter');
    const csv = generateEditorCSV([{ vendorName: cv.vendors.name, merchantId: client.merchant_id }], budget, await getCampaignPrefix());
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${cv.vendors.name.replace(/[^a-z0-9]/gi, '_')}_campaigns.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CAMPAIGN ID LINKING
// ============================================================

// POST /api/clients/:id/vendors/:vendorId/campaigns/link — Link campaign IDs (account_manager+)
router.post('/:id/vendors/:vendorId/campaigns/link', requirePermission('create_campaigns'), async (req, res) => {
  try {
    const { general_campaign_id, brand_campaign_id, product_campaign_id } = req.body;

    if (!general_campaign_id || !brand_campaign_id || !product_campaign_id) {
      return res.status(400).json({ error: 'All three campaign IDs are required (general_campaign_id, brand_campaign_id, product_campaign_id)' });
    }

    const campaignIds = { General: general_campaign_id, Brand: brand_campaign_id, Product: product_campaign_id };
    for (const [tier, id] of Object.entries(campaignIds)) {
      if (!/^\d+$/.test(id)) return res.status(400).json({ error: `${tier} campaign ID must be numeric` });
    }

    // Verify client-vendor assignment
    const { data: cv, error: cvErr } = await supabase
      .from('client_vendors')
      .select('id, campaigns_created, vendors(id, name)')
      .eq('client_id', req.params.id)
      .eq('vendor_id', req.params.vendorId)
      .single();
    if (cvErr || !cv) return res.status(404).json({ error: 'Vendor not assigned to this client' });
    if (cv.campaigns_created) return res.status(409).json({ error: 'Campaigns already linked for this vendor' });

    const vendorName = cv.vendors.name;
    const linkPrefix = await getCampaignPrefix();
    const configRows = TIER_CONFIG.map(tier => ({
      client_id: req.params.id,
      vendor_id: req.params.vendorId,
      tier: tier.tier,
      campaign_name: buildCampaignName(linkPrefix, vendorName, tier.name),
      ad_group_name: buildCampaignName(linkPrefix, vendorName, tier.name),
      blocks_master: tier.blocks_master,
      blocks_brand: tier.blocks_brand,
      blocks_product: tier.blocks_product,
      google_campaign_id: campaignIds[tier.name],
    }));

    const { error: insertErr } = await supabase.from('campaign_configs').insert(configRows);
    if (insertErr) throw insertErr;

    await supabase
      .from('client_vendors')
      .update({ campaigns_created: true, campaigns_created_at: new Date().toISOString() })
      .eq('client_id', req.params.id)
      .eq('vendor_id', req.params.vendorId);

    res.json({ message: `Campaign IDs linked for ${vendorName}`, configs: configRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clients/:id/vendors/:vendorId/sync-master-negatives
 * Pushes negatives for THIS VENDOR only:
 *   - Master Negatives (SharedSet, client-wide) → attached to all tracked campaigns
 *   - Brand keywords   → direct CampaignCriterion negatives on Product-tier campaign
 *                        (the one where blocks_brand=TRUE)
 *   - Product keywords → direct CampaignCriterion negatives on Brand-tier campaign
 *                        (the one where blocks_product=TRUE)
 * Idempotent — diff-add / diff-remove.
 */
router.post('/:id/vendors/:vendorId/sync-master-negatives', requirePermission('edit_client'), async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) return res.status(403).json({ error: 'Forbidden: client not in your scope' });

    const { client, customer, customerId } = await loadClientCustomer(req.params.id);

    // Confirm vendor assignment
    const { data: cv } = await supabase
      .from('client_vendors')
      .select('id, vendors(id, name)')
      .eq('client_id', req.params.id)
      .eq('vendor_id', req.params.vendorId)
      .single();
    if (!cv) return res.status(404).json({ error: 'Vendor not assigned to this client' });
    const vendorName = cv.vendors?.name || 'vendor';

    // This vendor's campaign_configs (for brand/product target campaigns)
    const { data: vendorConfigs } = await supabase
      .from('campaign_configs')
      .select('google_campaign_id, blocks_brand, blocks_product')
      .eq('client_id', req.params.id)
      .eq('vendor_id', req.params.vendorId)
      .not('google_campaign_id', 'is', null);

    if (!vendorConfigs || !vendorConfigs.length) {
      return res.status(400).json({ error: `No tracked campaigns found for ${vendorName}. Create campaigns first.` });
    }

    // All client campaigns (for master SharedSet attachment)
    const { data: allConfigs } = await supabase
      .from('campaign_configs')
      .select('google_campaign_id')
      .eq('client_id', req.params.id)
      .not('google_campaign_id', 'is', null);
    const allCampaignIds = [...new Set((allConfigs || []).map(c => c.google_campaign_id))];

    // Keywords: general (client-wide) + this vendor's brand + this vendor's product
    const [negRes, brandRes, productRes] = await Promise.all([
      supabase.from('general_negatives').select('keyword, match_type'),
      supabase.from('vendor_keywords').select('keyword').eq('campaign_type', 'brand').eq('is_active', true).eq('vendor_id', req.params.vendorId),
      supabase.from('vendor_keywords').select('keyword').eq('campaign_type', 'product').eq('is_active', true).eq('vendor_id', req.params.vendorId),
    ]);

    const brandKeywords = (brandRes.data || []).map(r => ({ keyword: r.keyword, match_type: 'broad' }));
    const productKeywords = (productRes.data || []).map(r => ({ keyword: r.keyword, match_type: 'broad' }));

    const [masterResult, vendorResult] = await Promise.all([
      syncMasterNegativesForClient(customer, customerId, client, negRes.data || [], allCampaignIds),
      syncVendorNegatives(customer, customerId, vendorName, brandKeywords, productKeywords, vendorConfigs),
    ]);

    // Persist timestamps + master resource name (if newly created or recovered)
    const now = new Date().toISOString();
    const clientUpdates = { master_negatives_synced_at: now };
    if (masterResult.resourceName && masterResult.resourceName !== client.master_shared_set_resource_name) {
      clientUpdates.master_shared_set_resource_name = masterResult.resourceName;
    }
    await Promise.all([
      supabase.from('clients').update(clientUpdates).eq('id', req.params.id),
      supabase.from('client_vendors')
        .update({ master_negatives_synced_at: now })
        .eq('client_id', req.params.id).eq('vendor_id', req.params.vendorId),
    ]);

    res.json({
      vendor: vendorName,
      general: masterResult,
      brand: vendorResult.brand,
      product: vendorResult.product,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CAMPAIGN-LEVEL OPTIMIZATIONS
// ============================================================

/**
 * Helper: load a client + build an authenticated Google Ads customer (falls back to direct
 * access if MCC login fails). Returns { client, customer, customerId }.
 */
async function loadClientCustomer(clientId) {
  const { data: client, error } = await supabase
    .from('clients')
    .select('id, name, google_ads_customer_id, oauth_refresh_token, mcc_account_id, master_shared_set_resource_name, block_mobile_apps')
    .eq('id', clientId)
    .single();
  if (error || !client) throw new Error('Client not found');
  if (!client.oauth_refresh_token) throw new Error('Client has no OAuth token. Connect Google Ads first.');

  const customerId = client.google_ads_customer_id.replace(/-/g, '');
  const mccId = client.mcc_account_id || null;
  let customer = createAdsClient(client.oauth_refresh_token, customerId, mccId);
  if (mccId) {
    try {
      await customer.query(`SELECT campaign.id FROM campaign LIMIT 1`);
    } catch (e) {
      customer = createAdsClient(client.oauth_refresh_token, customerId, null);
    }
  }
  return { client, customer, customerId };
}

/**
 * POST /api/clients/:id/apply-observation-audiences
 * Attaches the global default_observation_audiences list to every tracked campaign in Observation mode.
 */
router.post('/:id/apply-observation-audiences', requirePermission('edit_client'), async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) return res.status(403).json({ error: 'Forbidden: client not in your scope' });

    const { customer, customerId } = await loadClientCustomer(req.params.id);

    const { data: appSettings } = await supabase
      .from('app_settings')
      .select('default_observation_audiences')
      .eq('id', 1)
      .maybeSingle();

    const audiences = Array.isArray(appSettings?.default_observation_audiences)
      ? appSettings.default_observation_audiences
      : [];

    if (!audiences.length) return res.status(400).json({ error: 'No default_observation_audiences configured in Settings.' });

    const { data: configs } = await supabase
      .from('campaign_configs')
      .select('google_ad_group_id')
      .eq('client_id', req.params.id)
      .not('google_ad_group_id', 'is', null);

    const adGroupIds = [...new Set((configs || []).map(c => c.google_ad_group_id))];
    if (!adGroupIds.length) return res.status(400).json({ error: 'No tracked ad groups found for this client.' });

    const result = await applyObservationAudiences(customer, customerId, adGroupIds, audiences);
    res.json({ audiencesApplied: audiences.length, campaignsTargeted: adGroupIds.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clients/:id/block-mobile-apps
 * Ensures an account-wide CustomerNegativeCriterion exists for the mobile-app category.
 * Idempotent.
 */
router.post('/:id/block-mobile-apps', requirePermission('edit_client'), async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) return res.status(403).json({ error: 'Forbidden: client not in your scope' });

    const { customer } = await loadClientCustomer(req.params.id);

    const { data: appSettings } = await supabase
      .from('app_settings')
      .select('mobile_app_category_id')
      .eq('id', 1)
      .maybeSingle();
    const categoryId = req.body?.category_id || appSettings?.mobile_app_category_id || '69500';

    const result = await ensureMobileAppBlock(customer, categoryId);

    if (result.added || result.existed) {
      await supabase
        .from('clients')
        .update({ mobile_apps_blocked_at: new Date().toISOString(), block_mobile_apps: true })
        .eq('id', req.params.id);
    }

    res.json({ categoryId, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clients/:id/sync-master-negatives
 * Client-wide sync:
 *   - Master Negatives (SharedSet) rebuilt + attached to every tracked campaign
 *   - For each assigned vendor: Brand + Product keyword lists pushed as direct
 *     CampaignCriterion negatives on the appropriate tier campaigns
 * Idempotent. Self-heals if the Master SharedSet was deleted in the Ads UI.
 */
router.post('/:id/sync-master-negatives', requirePermission('edit_client'), async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) return res.status(403).json({ error: 'Forbidden: client not in your scope' });

    const { client, customer, customerId } = await loadClientCustomer(req.params.id);

    // Load all client_vendor rows (name only — no more shared-set columns)
    const { data: cvRows } = await supabase
      .from('client_vendors')
      .select('id, vendor_id, vendors(id, name)')
      .eq('client_id', req.params.id);

    // Load general negatives + all campaign configs once
    const [negRes, allConfigsRes] = await Promise.all([
      supabase.from('general_negatives').select('keyword, match_type'),
      supabase
        .from('campaign_configs')
        .select('google_campaign_id, vendor_id, blocks_brand, blocks_product')
        .eq('client_id', req.params.id)
        .not('google_campaign_id', 'is', null),
    ]);

    const allCampaignIds = [...new Set((allConfigsRes.data || []).map(c => c.google_campaign_id))];

    // 1. Master Negatives (SharedSet, client-wide)
    const masterResult = await syncMasterNegativesForClient(
      customer, customerId, client, negRes.data || [], allCampaignIds
    );

    // 2. Per-vendor Brand + Product — direct CampaignCriterion negatives
    const vendorResults = [];
    for (const cv of (cvRows || [])) {
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

      // Stamp timestamp on this vendor row
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
    await supabase.from('clients').update(clientUpdates).eq('id', req.params.id);

    res.json({
      general: masterResult,
      vendors: vendorResults,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/clients/:id/rebuild-master-negatives
 * Force-creates a fresh Master Negatives SharedSet regardless of any cached
 * resource name, pushes all master keywords, attaches to every tracked
 * campaign. Use this when the old SharedSet was deleted in the Google Ads UI
 * and a self-heal on the next Sync isn't fast enough.
 *
 * Only rebuilds the Master SharedSet — per-vendor brand/product are already
 * self-healing (they're direct campaign negatives; the regular Sync diff-adds
 * anything missing).
 */
router.post('/:id/rebuild-master-negatives', requirePermission('edit_client'), async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) return res.status(403).json({ error: 'Forbidden: client not in your scope' });

    const { client, customer, customerId } = await loadClientCustomer(req.params.id);

    const [negRes, allConfigsRes] = await Promise.all([
      supabase.from('general_negatives').select('keyword, match_type'),
      supabase
        .from('campaign_configs')
        .select('google_campaign_id')
        .eq('client_id', req.params.id)
        .not('google_campaign_id', 'is', null),
    ]);

    const allCampaignIds = [...new Set((allConfigsRes.data || []).map(c => c.google_campaign_id))];

    const result = await rebuildMasterSharedSet(
      customer, customerId, client, negRes.data || [], allCampaignIds
    );

    // Persist fresh resource name + timestamp
    const clientUpdates = { master_negatives_synced_at: new Date().toISOString() };
    if (result.resourceName) {
      clientUpdates.master_shared_set_resource_name = result.resourceName;
    }
    await supabase.from('clients').update(clientUpdates).eq('id', req.params.id);

    res.json({ general: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/clients/:id/url-audit
 * Lists every campaign on the account that has a non-empty tracking_url_template
 * or final_url_suffix — these are typically stale UTM params left by prior agencies.
 */
router.get('/:id/url-audit', async (req, res) => {
  try {
    if (!isInScope(req, req.params.id)) return res.status(403).json({ error: 'Forbidden: client not in your scope' });

    const { customer } = await loadClientCustomer(req.params.id);
    const issues = await getUrlTrackingIssues(customer);
    res.json({ issues, count: issues.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
