const config = require('../config');
const { supabase } = require('../db');
const {
  createAdsClient,
  applyObservationAudiences,
  ensureMobileAppBlock,
  syncMasterNegativesForClient,
  syncVendorNegatives,
  formatGoogleAdsError,
} = require('./googleAds');
const { getCampaignPrefix, campaignName, adGroupName, budgetName, DEFAULT_PREFIX } = require('../naming');

const TIER_CONFIG = [
  {
    tier: 1,
    name: 'General',
    priority: 2,    // HIGH
    cpcMicros: 50000, // $0.05
    blocks_master: false,
    blocks_brand: false,
    blocks_product: false,
  },
  {
    tier: 2,
    name: 'Brand',
    priority: 1,    // MEDIUM
    cpcMicros: 100000, // $0.10
    blocks_master: true,
    blocks_brand: false,
    blocks_product: true,
  },
  {
    tier: 3,
    name: 'Product',
    priority: 0,    // LOW
    cpcMicros: 250000, // $0.25
    blocks_master: true,
    blocks_brand: true,
    blocks_product: false,
  },
];

/**
 * Create 3 Shopping campaigns + shared budget + ad groups for a vendor under a client.
 *
 * @param {string} clientId - Client UUID
 * @param {string} vendorId - Vendor UUID
 * @param {number} budgetDollars - Daily shared budget in dollars (default 50)
 * @returns {{ campaigns: Array, budget: string }}
 */
async function createVendorCampaigns(clientId, vendorId, budgetDollars = 50) {
  // 1. Load client
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('id, name, google_ads_customer_id, oauth_refresh_token, merchant_id, mcc_account_id, master_shared_set_resource_name, block_mobile_apps')
    .eq('id', clientId)
    .single();

  if (clientErr || !client) throw new Error('Client not found');
  if (!client.oauth_refresh_token) throw new Error('Client has no OAuth token. Connect Google Ads first.');
  if (!client.merchant_id) throw new Error('Client has no Merchant Center ID. Set it in client settings.');
  if (!client.google_ads_customer_id) throw new Error('Client has no Google Ads Customer ID.');

  // 2. Load vendor
  const { data: vendor, error: vendorErr } = await supabase
    .from('vendors')
    .select('id, name')
    .eq('id', vendorId)
    .single();

  if (vendorErr || !vendor) throw new Error('Vendor not found');

  // 3. Check vendor is assigned to client
  const { data: cv, error: cvErr } = await supabase
    .from('client_vendors')
    .select('id, campaigns_created')
    .eq('client_id', clientId)
    .eq('vendor_id', vendorId)
    .single();

  if (cvErr || !cv) throw new Error('Vendor is not assigned to this client');
  if (cv.campaigns_created) throw new Error(`Campaigns already created for vendor "${vendor.name}"`);

  // 4. Create Google Ads API client (try with MCC first, fall back to direct)
  const customerId = client.google_ads_customer_id.replace(/-/g, '');
  const mccId = client.mcc_account_id || null;
  let customer = createAdsClient(client.oauth_refresh_token, customerId, mccId);

  // Quick connectivity check — if MCC fails, try direct access
  if (mccId) {
    try {
      await customer.query(`SELECT campaign.id FROM campaign LIMIT 1`);
    } catch (e) {
      console.log('MCC access failed, trying direct access:', formatGoogleAdsError(e));
      customer = createAdsClient(client.oauth_refresh_token, customerId, null);
    }
  }

  const vendorName = vendor.name;
  const budgetMicros = budgetDollars * 1_000_000;
  const prefix = await getCampaignPrefix();

  // Merchant Center feed label for new Shopping campaigns. Global setting so
  // non-US advertisers aren't stuck with a hardcoded 'US'. null = omit it and
  // let Google fall back to the account default.
  const { data: feedSetting } = await supabase
    .from('app_settings')
    .select('default_feed_label')
    .eq('id', 1)
    .maybeSingle();
  const feedLabel = (feedSetting?.default_feed_label || '').trim() || null;

  // 5. Build mutation operations with temp resource IDs
  const BUDGET_TEMP = -1;
  const CAMP_GENERAL_TEMP = -2;
  const CAMP_BRAND_TEMP = -3;
  const CAMP_PRODUCT_TEMP = -4;
  const AG_GENERAL_TEMP = -5;
  const AG_BRAND_TEMP = -6;
  const AG_PRODUCT_TEMP = -7;

  const campaignTempIds = [CAMP_GENERAL_TEMP, CAMP_BRAND_TEMP, CAMP_PRODUCT_TEMP];
  const adGroupTempIds = [AG_GENERAL_TEMP, AG_BRAND_TEMP, AG_PRODUCT_TEMP];

  const mutations = [
    // Shared budget
    {
      entity: 'campaign_budget',
      operation: 'create',
      resource: {
        resource_name: `customers/${customerId}/campaignBudgets/${BUDGET_TEMP}`,
        name: budgetName(prefix, vendorName),
        amount_micros: budgetMicros,
        delivery_method: 2, // STANDARD
        explicitly_shared: true,
      },
    },
    // 3 campaigns
    ...TIER_CONFIG.map((tier, i) => ({
      entity: 'campaign',
      operation: 'create',
      resource: {
        resource_name: `customers/${customerId}/campaigns/${campaignTempIds[i]}`,
        name: campaignName(prefix, vendorName, tier.name),
        advertising_channel_type: 4, // SHOPPING
        status: 3, // PAUSED
        campaign_budget: `customers/${customerId}/campaignBudgets/${BUDGET_TEMP}`,
        shopping_setting: {
          merchant_id: parseInt(client.merchant_id),
          campaign_priority: tier.priority,
          ...(feedLabel ? { feed_label: feedLabel } : {}),
        },
        manual_cpc: {},
        contains_eu_political_advertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      },
    })),
    // 3 ad groups
    ...TIER_CONFIG.map((tier, i) => ({
      entity: 'ad_group',
      operation: 'create',
      resource: {
        resource_name: `customers/${customerId}/adGroups/${adGroupTempIds[i]}`,
        name: adGroupName(prefix, vendorName, tier.name),
        campaign: `customers/${customerId}/campaigns/${campaignTempIds[i]}`,
        type: 4, // SHOPPING_PRODUCT_ADS
        cpc_bid_micros: tier.cpcMicros,
        status: 2, // ENABLED
      },
    })),
  ];

  // 6. Execute atomic mutation
  let response;
  try {
    response = await customer.mutateResources(mutations);
  } catch (err) {
    // Log detailed error info for debugging
    console.warn('mutateResources failed:', err.message);
    if (err.errors) console.warn('Google Ads API errors:', JSON.stringify(err.errors, null, 2));
    if (err.metadata) console.warn('Error metadata:', JSON.stringify(err.metadata, null, 2));
    console.warn('Trying sequential approach...');
    response = await createSequential(customer, customerId, vendorName, budgetMicros, client.merchant_id, prefix, feedLabel);
  }

  // 7. Extract real resource IDs from response
  const results = response.mutate_operation_responses || response.results || [];
  const extractId = (resourceName) => {
    if (!resourceName) return null;
    const parts = resourceName.split('/');
    return parts[parts.length - 1];
  };

  // Results order: budget, 3 campaigns, 3 ad groups
  const budgetResult = results[0];
  const campaignResults = results.slice(1, 4);
  const adGroupResults = results.slice(4, 7);

  const budgetId = extractId(
    budgetResult?.campaign_budget_result?.resource_name ||
    budgetResult?.resource_name
  );
  const campaignIds = campaignResults.map(r => extractId(
    r?.campaign_result?.resource_name || r?.resource_name
  ));
  const adGroupIds = adGroupResults.map(r => extractId(
    r?.ad_group_result?.resource_name || r?.resource_name
  ));

  // 8. Insert campaign_configs rows
  const configRows = TIER_CONFIG.map((tier, i) => ({
    client_id: clientId,
    vendor_id: vendorId,
    tier: tier.tier,
    campaign_name: campaignName(prefix, vendorName, tier.name),
    ad_group_name: adGroupName(prefix, vendorName, tier.name),
    blocks_master: tier.blocks_master,
    blocks_brand: tier.blocks_brand,
    blocks_product: tier.blocks_product,
    google_campaign_id: campaignIds[i],
    google_ad_group_id: adGroupIds[i],
    google_budget_id: budgetId,
  }));

  const { error: insertErr } = await supabase.from('campaign_configs').insert(configRows);
  if (insertErr) {
    console.error('Failed to save campaign configs:', insertErr);
    throw new Error('Campaigns created in Google Ads but failed to save config: ' + insertErr.message);
  }

  // 9. Mark campaigns as created
  await supabase
    .from('client_vendors')
    .update({ campaigns_created: true, campaigns_created_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .eq('vendor_id', vendorId);

  // 10. Apply campaign-level optimizations. Best-effort — failures here don't roll back creation.
  const { data: appSettings } = await supabase
    .from('app_settings')
    .select('default_observation_audiences, default_block_mobile_apps, mobile_app_category_id')
    .eq('id', 1)
    .maybeSingle();

  const observationAudiences = Array.isArray(appSettings?.default_observation_audiences)
    ? appSettings.default_observation_audiences
    : [];

  // block_mobile_apps: client flag is the source of truth; if null/undefined fall back to global default.
  const blockApps = client.block_mobile_apps !== false && (appSettings?.default_block_mobile_apps !== false);
  const mobileCategoryId = appSettings?.mobile_app_category_id || '69500';

  let audienceResult = { added: 0, skipped: 0, errors: 0 };
  let mobileResult = { skipped: true };
  let sharedSetResult = { skipped: true };

  if (observationAudiences.length > 0) {
    audienceResult = await applyObservationAudiences(customer, customerId, adGroupIds, observationAudiences);
    console.log(`[${client.name}/${vendorName}] Observation audiences @ ad-group: +${audienceResult.added}, skipped ${audienceResult.skipped}, errors ${audienceResult.errors}`);
  }

  // Account-wide mobile-app block (CustomerNegativeCriterion). One-shot per client account.
  if (blockApps) {
    mobileResult = await ensureMobileAppBlock(customer, mobileCategoryId);
    if (mobileResult.added || mobileResult.existed) {
      await supabase
        .from('clients')
        .update({ mobile_apps_blocked_at: new Date().toISOString() })
        .eq('id', clientId);
    }
    console.log(`[${client.name}/${vendorName}] Mobile-app block (cat ${mobileCategoryId}): ${mobileResult.added ? 'ADDED' : mobileResult.existed ? 'existed' : 'FAILED: ' + mobileResult.error}`);
  }

  // Waterfall negatives:
  //   - Master Negatives (SharedSet, client-wide) → attached to every tracked campaign
  //   - This vendor's Brand + Product → direct CampaignCriterion negatives on
  //     the Product-tier and Brand-tier campaigns respectively (no SharedSet)
  try {
    // Load general negatives + this vendor's own keywords
    const [negRes, vendorBrandRes, vendorProductRes, allConfigsRes, thisVendorConfigsRes] = await Promise.all([
      supabase.from('general_negatives').select('keyword, match_type'),
      supabase.from('vendor_keywords').select('keyword').eq('campaign_type', 'brand').eq('is_active', true).eq('vendor_id', vendorId),
      supabase.from('vendor_keywords').select('keyword').eq('campaign_type', 'product').eq('is_active', true).eq('vendor_id', vendorId),
      supabase
        .from('campaign_configs')
        .select('google_campaign_id, blocks_brand, blocks_product')
        .eq('client_id', clientId)
        .not('google_campaign_id', 'is', null),
      supabase
        .from('campaign_configs')
        .select('google_campaign_id, blocks_brand, blocks_product')
        .eq('client_id', clientId)
        .eq('vendor_id', vendorId)
        .not('google_campaign_id', 'is', null),
    ]);

    const allCampaignIds = [...new Set((allConfigsRes.data || []).map(c => c.google_campaign_id))];
    const brandKeywords = (vendorBrandRes.data || []).map(r => ({ keyword: r.keyword, match_type: 'broad' }));
    const productKeywords = (vendorProductRes.data || []).map(r => ({ keyword: r.keyword, match_type: 'broad' }));

    // 1. Master (SharedSet, client-wide)
    const masterResult = await syncMasterNegativesForClient(
      customer, customerId, client, negRes.data || [], allCampaignIds
    );

    // 2. This vendor's brand + product — direct CampaignCriterion negatives
    const vendorResult = await syncVendorNegatives(
      customer, customerId, vendorName,
      brandKeywords, productKeywords,
      thisVendorConfigsRes.data || []
    );

    // Persist timestamps + master resource name (if newly created)
    const now = new Date().toISOString();
    const clientUpdates = { master_negatives_synced_at: now };
    if (masterResult.resourceName && masterResult.resourceName !== client.master_shared_set_resource_name) {
      clientUpdates.master_shared_set_resource_name = masterResult.resourceName;
    }
    await Promise.all([
      supabase.from('clients').update(clientUpdates).eq('id', clientId),
      supabase.from('client_vendors')
        .update({ master_negatives_synced_at: now })
        .eq('client_id', clientId).eq('vendor_id', vendorId),
    ]);

    sharedSetResult = {
      general: masterResult,
      brand: vendorResult.brand,
      product: vendorResult.product,
      vendor: vendorName,
    };
    console.log(`[${client.name}/${vendorName}] Waterfall negatives — Master: +${masterResult.added}/-${masterResult.removed} attached ${masterResult.attached}${masterResult.recovered ? ' (RECOVERED from deleted set)' : ''}; Brand: +${vendorResult.brand.added}/-${vendorResult.brand.removed} on ${vendorResult.brand.campaignIds?.length || 0} campaign(s); Product: +${vendorResult.product.added}/-${vendorResult.product.removed} on ${vendorResult.product.campaignIds?.length || 0} campaign(s)`);
  } catch (err) {
    sharedSetResult = { error: err.message };
    console.warn(`[${client.name}/${vendorName}] Waterfall negatives sync failed:`, err.message);
  }

  return {
    vendor: vendorName,
    budgetId,
    campaigns: TIER_CONFIG.map((tier, i) => ({
      tier: tier.name,
      campaignId: campaignIds[i],
      adGroupId: adGroupIds[i],
      priority: tier.priority,
      cpcBid: `$${(tier.cpcMicros / 1_000_000).toFixed(2)}`,
    })),
    optimizations: {
      observationAudiences: { count: observationAudiences.length, ...audienceResult },
      mobileAppBlock: mobileResult,
      masterSharedSet: sharedSetResult,
    },
  };
}

/**
 * Fallback: create budget, campaigns, ad groups sequentially.
 */
async function createSequential(customer, customerId, vendorName, budgetMicros, merchantId, prefix = DEFAULT_PREFIX, feedLabel = null) {
  // Create budget
  const budgetResponse = await customer.campaignBudgets.create([{
    name: budgetName(prefix, vendorName),
    amount_micros: budgetMicros,
    delivery_method: 2,
    explicitly_shared: true,
  }]);

  const budgetResourceName = budgetResponse.results[0].resource_name;

  // Create 3 campaigns
  const campaignResponse = await customer.campaigns.create(
    TIER_CONFIG.map(tier => ({
      name: campaignName(prefix, vendorName, tier.name),
      advertising_channel_type: 6,
      status: 3,
      campaign_budget: budgetResourceName,
      shopping_setting: {
        merchant_id: parseInt(merchantId),
        campaign_priority: tier.priority,
        ...(feedLabel ? { feed_label: feedLabel } : {}),
      },
      manual_cpc: { enhanced_cpc_enabled: false },
    }))
  );

  const campaignResourceNames = campaignResponse.results.map(r => r.resource_name);

  // Create 3 ad groups
  const adGroupResponse = await customer.adGroups.create(
    TIER_CONFIG.map((tier, i) => ({
      name: adGroupName(prefix, vendorName, tier.name),
      campaign: campaignResourceNames[i],
      type: 2,
      cpc_bid_micros: tier.cpcMicros,
      status: 2,
    }))
  );

  // Build a response format matching mutateResources
  return {
    mutate_operation_responses: [
      { campaign_budget_result: { resource_name: budgetResourceName } },
      ...campaignResponse.results.map(r => ({ campaign_result: { resource_name: r.resource_name } })),
      ...adGroupResponse.results.map(r => ({ ad_group_result: { resource_name: r.resource_name } })),
    ],
  };
}

/**
 * Create campaigns for all vendors assigned to a client that don't have them yet.
 */
async function createAllVendorCampaigns(clientId, budgetDollars = 50) {
  const { data: vendors, error } = await supabase
    .from('client_vendors')
    .select('vendor_id, campaigns_created, vendors(id, name)')
    .eq('client_id', clientId)
    .eq('campaigns_created', false);

  if (error) throw error;
  if (!vendors.length) return { created: 0, skipped: 0, results: [] };

  const results = [];
  let created = 0;
  let errors = 0;

  for (const cv of vendors) {
    try {
      const result = await createVendorCampaigns(clientId, cv.vendor_id, budgetDollars);
      results.push({ vendor: cv.vendors?.name, status: 'success', ...result });
      created++;
    } catch (err) {
      results.push({ vendor: cv.vendors?.name, status: 'error', error: err.message });
      errors++;
    }
  }

  return { created, errors, skipped: 0, results };
}

module.exports = {
  createVendorCampaigns,
  createAllVendorCampaigns,
  TIER_CONFIG,
};
