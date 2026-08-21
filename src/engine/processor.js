const { supabase } = require('../db');
const googleAds = require('./googleAds');
const { normalize, isKeywordInsideSearchTerm, containsGeneralNegative, sortKeywordsByLength } = require('./matcher');

/**
 * Process a single client — the full waterfall engine run.
 * This is the main function that replaces both Google Ads scripts.
 *
 * @param {object} client - Client record from database
 * @returns {object} Run results
 */
async function processClient(client) {
  const startTime = new Date();
  let runLogId = null;

  try {
    // Create run log entry
    const { data: runLog, error: logError } = await supabase
      .from('run_logs')
      .insert({
        client_id: client.id,
        status: 'running',
        started_at: startTime.toISOString(),
      })
      .select()
      .single();

    if (logError) throw new Error(`Failed to create run log: ${logError.message}`);
    runLogId = runLog.id;

    console.log(`[${client.name}] Starting engine run...`);

    // Step 1: Load keywords from database
    const { masterKeywords, brandKeywords, productKeywords, generalNegatives } = await loadKeywords(client.id);

    // Build separate normalized keyword lists
    const masterKwList = sortKeywordsByLength(masterKeywords.map(k => normalize(k.keyword)));
    const brandKwList = sortKeywordsByLength(brandKeywords.map(k => normalize(k.keyword)));
    const productKwList = sortKeywordsByLength(productKeywords.map(k => normalize(k.keyword)));
    const sortedGeneralNegatives = generalNegatives.map(n => normalize(n.keyword));

    const totalVendor = brandKeywords.length + productKeywords.length;
    console.log(`[${client.name}] Active keywords: ${masterKeywords.length} master + ${totalVendor} vendor (${brandKeywords.length} brand, ${productKeywords.length} product)`);
    console.log(`[${client.name}] General negatives: ${sortedGeneralNegatives.length}`);

    // Step 2: Connect to Google Ads (try MCC first, fall back to direct)
    const customerId = client.google_ads_customer_id.replace(/-/g, '');
    const mccId = client.mcc_account_id || null;
    let customer = googleAds.createAdsClient(client.oauth_refresh_token, customerId, mccId);
    if (mccId) {
      try {
        await customer.query(`SELECT campaign.id FROM campaign LIMIT 1`);
      } catch (e) {
        console.log(`[${client.name}] MCC access failed, using direct access:`, googleAds.formatGoogleAdsError(e));
        customer = googleAds.createAdsClient(client.oauth_refresh_token, customerId, null);
      }
    }

    // Step 3: Load campaign configs from database
    const { data: configs, error: configError } = await supabase
      .from('campaign_configs')
      .select('*')
      .eq('client_id', client.id);

    if (configError) throw new Error(`Failed to load campaign configs: ${configError.message}`);

    // Step 3b: Get shopping campaigns — prefer ID-based lookup if vendor configs exist
    const vendorConfigs = configs.filter(c => c.vendor_id && c.google_campaign_id);
    let campaigns;

    if (vendorConfigs.length > 0) {
      // Per-vendor mode: look up campaigns by stored IDs
      const configCampaignIds = [...new Set(vendorConfigs.map(c => c.google_campaign_id))];
      campaigns = await googleAds.getShoppingCampaignsByIds(customer, configCampaignIds);
    } else if (client.campaign_prefix) {
      // Legacy mode: discover by name prefix
      campaigns = await googleAds.getShoppingCampaigns(customer, client.campaign_prefix);
    } else {
      campaigns = [];
    }

    if (campaigns.length === 0) {
      throw new Error('No active Shopping campaigns found. Create campaigns for assigned vendors first.');
    }

    console.log(`[${client.name}] Found ${campaigns.length} ad groups across ${new Set(campaigns.map(c => c.campaignId)).size} campaigns`);

    // Step 5: Get search queries
    const campaignIds = [...new Set(campaigns.map(c => c.campaignId))];
    const searchQueries = await googleAds.getSearchQueries(
      customer,
      campaignIds,
      client.date_range || 'TODAY',
      client.impression_threshold || 0
    );

    console.log(`[${client.name}] Retrieved ${searchQueries.length} search queries`);

    // Step 6: Get existing negatives to avoid duplicates
    const adGroupIds = campaigns.map(c => c.adGroupId);
    const existingNegatives = await googleAds.getExistingNegatives(customer, adGroupIds);

    // Step 7: Process each query through the waterfall
    const results = processQueries(searchQueries, masterKwList, brandKwList, productKwList, sortedGeneralNegatives, campaigns, configs);

    // Step 8: Apply negative keywords
    const addResults = await applyNegatives(customer, results, existingNegatives);

    // Step 9: Record history
    await recordHistory(client.id, runLogId, results);

    // Step 10: Update run log with success
    const completedAt = new Date();
    await supabase
      .from('run_logs')
      .update({
        status: 'success',
        completed_at: completedAt.toISOString(),
        queries_processed: searchQueries.length,
        queries_matched: results.matched.length,
        negatives_added: addResults.totalAdded,
        general_negatives_added: addResults.generalAdded,
        details_json: {
          duration_ms: completedAt - startTime,
          keywords_master: masterKwList.length,
          keywords_brand: brandKwList.length,
          keywords_product: productKwList.length,
          campaigns_found: campaignIds.length,
          ad_groups_found: adGroupIds.length,
          queries_total: searchQueries.length,
          queries_matched: results.matched.length,
          queries_blocked: results.blocked.length,
          general_blocked: results.generalBlocked.length,
          negatives_added: addResults.totalAdded,
          negatives_skipped: addResults.totalSkipped,
          negatives_errors: addResults.totalErrors,
        },
      })
      .eq('id', runLogId);

    console.log(`[${client.name}] Run complete. Processed: ${searchQueries.length}, Matched: ${results.matched.length}, Blocked: ${results.blocked.length}, Negatives added: ${addResults.totalAdded}`);

    return {
      success: true,
      runLogId,
      queriesProcessed: searchQueries.length,
      matched: results.matched.length,
      blocked: results.blocked.length,
      negativesAdded: addResults.totalAdded,
    };

  } catch (err) {
    console.error(`[${client.name}] Engine error:`, err.message);

    // Update run log with error
    if (runLogId) {
      await supabase
        .from('run_logs')
        .update({
          status: 'error',
          completed_at: new Date().toISOString(),
          error_message: err.message,
        })
        .eq('id', runLogId);
    }

    return {
      success: false,
      runLogId,
      error: err.message,
    };
  }
}

/**
 * Load all keywords from the database for a client.
 * Vendor keywords are split by campaign_type (brand/product).
 */
async function loadKeywords(clientId) {
  // Get vendor IDs assigned to this client
  const { data: clientVendors, error: cvError } = await supabase
    .from('client_vendors')
    .select('vendor_id')
    .eq('client_id', clientId);

  if (cvError) throw new Error(`Failed to load client vendors: ${cvError.message}`);

  const vendorIds = (clientVendors || []).map(cv => cv.vendor_id);

  // Load master keywords, vendor keywords (for assigned vendors), and general negatives
  const [masterRes, negRes] = await Promise.all([
    supabase.from('master_keywords').select('keyword, category'),
    supabase.from('general_negatives').select('keyword'),
  ]);

  if (masterRes.error) throw new Error(`Failed to load master keywords: ${masterRes.error.message}`);
  if (negRes.error) throw new Error(`Failed to load general negatives: ${negRes.error.message}`);

  let vendorData = [];
  if (vendorIds.length > 0) {
    const { data, error } = await supabase
      .from('vendor_keywords')
      .select('keyword, campaign_type')
      .in('vendor_id', vendorIds);

    if (error) throw new Error(`Failed to load vendor keywords: ${error.message}`);
    vendorData = data || [];
  }

  return {
    masterKeywords: masterRes.data || [],
    brandKeywords: vendorData.filter(k => k.campaign_type === 'brand'),
    productKeywords: vendorData.filter(k => k.campaign_type === 'product'),
    generalNegatives: negRes.data || [],
  };
}

/**
 * Process search queries through the waterfall matching logic.
 * Each query is evaluated per-campaign: a query may be allowed in one campaign
 * but blocked in another based on the campaign's blocking config.
 *
 * @returns {{ matched: Array, blocked: Array, generalBlocked: Array }}
 */
function processQueries(searchQueries, masterKwList, brandKwList, productKwList, generalNegatives, campaigns, configs) {
  const matched = [];        // Queries that match at least one keyword (for stats)
  const blocked = [];        // Per-campaign blocking decisions (to be negated)
  const generalBlocked = []; // Queries that hit general negatives (blocked in all campaigns)

  // Build config lookups — by campaign ID (per-vendor) and by tier (legacy)
  const configByCampaignId = {};
  const configByTier = {};
  for (const cfg of configs) {
    if (cfg.google_campaign_id) {
      configByCampaignId[cfg.google_campaign_id] = cfg;
    }
    // Legacy fallback: only use tier-based if no vendor_id (old-style configs)
    if (!cfg.vendor_id) {
      configByTier[cfg.tier] = cfg;
    }
  }

  // All keywords combined for general matching stats
  const allKeywords = sortKeywordsByLength([...masterKwList, ...brandKwList, ...productKwList]);

  for (const sq of searchQueries) {
    const normalizedQuery = normalize(sq.query);
    const tier = extractTier(sq.campaignName);
    // Prefer campaign-ID-based lookup (per-vendor), fall back to tier-based (legacy)
    const config = configByCampaignId[sq.campaignId] || (tier ? configByTier[tier] : null);

    // Check general negatives first — these always block in every campaign
    const genResult = containsGeneralNegative(normalizedQuery, generalNegatives);
    if (genResult.matched) {
      generalBlocked.push({
        ...sq,
        normalizedQuery,
        matchedNegative: genResult.keyword,
      });
      continue;
    }

    // Check if query matches any keyword at all (for stats tracking)
    const anyMatch = isKeywordInsideSearchTerm(normalizedQuery, allKeywords);

    if (!config) {
      // No config for this tier — if no keyword match, block it
      if (anyMatch.matched) {
        matched.push({ ...sq, normalizedQuery, matchedKeyword: anyMatch.keyword });
      } else {
        blocked.push({ ...sq, normalizedQuery });
      }
      continue;
    }

    // Build the set of keywords that should be NEGATED in this campaign
    // (i.e., keywords whose matching queries should be pushed away from this campaign)
    let negativeKeywords = [];
    if (config.blocks_master) negativeKeywords = negativeKeywords.concat(masterKwList);
    if (config.blocks_brand) negativeKeywords = negativeKeywords.concat(brandKwList);
    if (config.blocks_product) negativeKeywords = negativeKeywords.concat(productKwList);

    if (negativeKeywords.length === 0) {
      // This campaign blocks nothing (General tier) — allow everything through
      if (anyMatch.matched) {
        matched.push({ ...sq, normalizedQuery, matchedKeyword: anyMatch.keyword });
      }
      // Queries that don't match any keyword still get through General (no negatives added)
      // But we should still block truly irrelevant queries in General
      if (!anyMatch.matched) {
        blocked.push({ ...sq, normalizedQuery });
      }
      continue;
    }

    const sortedNegKw = sortKeywordsByLength(negativeKeywords);

    // Check if query matches a keyword that this campaign blocks
    const negMatch = isKeywordInsideSearchTerm(normalizedQuery, sortedNegKw);
    if (negMatch.matched) {
      // Query matches a blocked keyword set — add as negative to push it to the right campaign
      blocked.push({ ...sq, normalizedQuery, matchedKeyword: negMatch.keyword });
    } else {
      // Query doesn't match any blocked keywords — it's allowed in this campaign
      if (anyMatch.matched) {
        matched.push({ ...sq, normalizedQuery, matchedKeyword: anyMatch.keyword });
      }
      // If it doesn't match ANY keyword, it stays (no action needed for this campaign)
    }
  }

  return { matched, blocked, generalBlocked };
}

/**
 * Apply the negative keywords via the Google Ads API.
 */
async function applyNegatives(customer, results, existingNegatives) {
  let totalAdded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let generalAdded = 0;

  // Blocked queries → exact match negatives on their respective ad groups
  if (results.blocked.length > 0) {
    const negatives = results.blocked.map(q => ({
      adGroupId: q.adGroupId,
      keyword: q.normalizedQuery,
      matchType: 'exact',
    }));

    const res = await googleAds.addNegativeKeywords(customer, negatives, existingNegatives);
    totalAdded += res.added;
    totalSkipped += res.skipped;
    totalErrors += res.errors;
  }

  // General negatives → exact match negatives on their respective ad groups
  if (results.generalBlocked.length > 0) {
    const negatives = results.generalBlocked.map(q => ({
      adGroupId: q.adGroupId,
      keyword: q.normalizedQuery,
      matchType: 'exact',
    }));

    const res = await googleAds.addNegativeKeywords(customer, negatives, existingNegatives);
    generalAdded = res.added;
    totalAdded += res.added;
    totalSkipped += res.skipped;
    totalErrors += res.errors;
  }

  return { totalAdded, totalSkipped, totalErrors, generalAdded };
}

/**
 * Record query history for the dashboard.
 */
async function recordHistory(clientId, runLogId, results) {
  const records = [];

  // Record matched (allowed) queries
  for (const q of results.matched) {
    records.push({
      client_id: clientId,
      run_log_id: runLogId,
      search_query: q.normalizedQuery,
      campaign_name: q.campaignName,
      ad_group_name: q.adGroupName,
      tier: extractTier(q.campaignName),
      match_type: 'exact',
      keyword_matched: q.matchedKeyword,
      was_blocked: false,
      impressions: q.impressions,
    });
  }

  // Record blocked queries
  for (const q of results.blocked) {
    records.push({
      client_id: clientId,
      run_log_id: runLogId,
      search_query: q.normalizedQuery,
      campaign_name: q.campaignName,
      ad_group_name: q.adGroupName,
      tier: extractTier(q.campaignName),
      match_type: 'exact',
      keyword_matched: null,
      was_blocked: true,
      impressions: q.impressions,
    });
  }

  // Record general negative blocked queries
  for (const q of results.generalBlocked) {
    records.push({
      client_id: clientId,
      run_log_id: runLogId,
      search_query: q.normalizedQuery,
      campaign_name: q.campaignName,
      ad_group_name: q.adGroupName,
      tier: extractTier(q.campaignName),
      match_type: 'broad',
      keyword_matched: q.matchedNegative,
      was_blocked: true,
      impressions: q.impressions,
    });
  }

  // Insert in batches of 1000
  const batchSize = 1000;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const { error } = await supabase.from('negative_keyword_history').insert(batch);
    if (error) {
      console.error('Error recording history batch:', error.message);
    }
  }
}

/**
 * Extract tier number from campaign name.
 * Supports both new names (General/Brand/Product) and legacy (Tier 1/2/3).
 */
function extractTier(campaignName) {
  if (!campaignName) return null;
  if (/\bGeneral\b/i.test(campaignName)) return 1;
  if (/\bBrand\b/i.test(campaignName)) return 2;
  if (/\bProduct\b/i.test(campaignName)) return 3;
  // Fallback for legacy tier names
  const match = campaignName.match(/Tier\s*(\d)/i);
  return match ? parseInt(match[1]) : null;
}

module.exports = { processClient };
