const { GoogleAdsApi } = require('google-ads-api');
const config = require('../config');
const { getCampaignPrefix, masterNegativesSharedSetName } = require('../naming');

/**
 * Create a Google Ads API client for a specific customer.
 *
 * @param {string} refreshToken - Client's OAuth refresh token
 * @param {string} customerId - Google Ads customer ID (no dashes)
 * @returns {object} Google Ads customer client
 */
function createAdsClient(refreshToken, customerId, loginCustomerId) {
  const client = new GoogleAdsApi({
    client_id: config.googleAds.clientId,
    client_secret: config.googleAds.clientSecret,
    developer_token: config.googleAds.developerToken,
  });

  const customerOpts = {
    customer_id: customerId.replace(/-/g, ''),
    refresh_token: refreshToken,
  };

  // Required when accessing child accounts via an MCC (manager) account
  if (loginCustomerId) {
    customerOpts.login_customer_id = loginCustomerId.replace(/-/g, '');
  }

  const customer = client.Customer(customerOpts);

  return customer;
}

/**
 * Get Shopping campaigns and ad groups matching the naming convention.
 * Replaces: ADGROUP_PERFORMANCE_REPORT query
 *
 * @param {object} customer - Google Ads customer client
 * @param {string} campaignPrefix - e.g., "Franklin"
 * @returns {Array} Array of { campaignId, campaignName, adGroupId, adGroupName, tier }
 */
async function getShoppingCampaigns(customer, campaignPrefix) {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      campaign.shopping_setting.campaign_priority
    FROM ad_group
    WHERE campaign.advertising_channel_type = 'SHOPPING'
      AND campaign.name LIKE '${campaignPrefix} | Shopping | Tier%'
      AND campaign.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
  `;

  const results = await customer.query(query);

  return results.map(row => {
    // Extract tier number from campaign name
    const tierMatch = row.campaign.name.match(/Tier\s*(\d)/i);
    const tier = tierMatch ? parseInt(tierMatch[1]) : null;

    return {
      campaignId: row.campaign.id.toString(),
      campaignName: row.campaign.name,
      adGroupId: row.ad_group.id.toString(),
      adGroupName: row.ad_group.name,
      tier,
    };
  });
}

/**
 * Get search query report for given ad groups.
 * Replaces: SEARCH_QUERY_PERFORMANCE_REPORT query
 *
 * @param {object} customer - Google Ads customer client
 * @param {string[]} campaignIds - Array of campaign IDs to query
 * @param {string} dateRange - Date range string (TODAY, YESTERDAY, LAST_7_DAYS, etc.)
 * @param {number} impressionThreshold - Minimum impressions
 * @returns {Array} Array of { query, campaignId, campaignName, adGroupId, adGroupName, impressions }
 */
async function getSearchQueries(customer, campaignIds, dateRange, impressionThreshold = 0) {
  // Map date range to GAQL format
  const dateClause = getDateClause(dateRange);

  const query = `
    SELECT
      search_term_view.search_term,
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      metrics.impressions
    FROM search_term_view
    WHERE campaign.id IN (${campaignIds.join(',')})
      AND metrics.impressions > ${impressionThreshold}
      ${dateClause}
  `;

  const results = await customer.query(query);

  return results.map(row => ({
    query: row.search_term_view.search_term,
    campaignId: row.campaign.id.toString(),
    campaignName: row.campaign.name,
    adGroupId: row.ad_group.id.toString(),
    adGroupName: row.ad_group.name,
    impressions: row.metrics.impressions,
  }));
}

/**
 * Get existing negative keywords for ad groups to avoid duplicates.
 *
 * @param {object} customer - Google Ads customer client
 * @param {string[]} adGroupIds - Array of ad group IDs
 * @returns {Set<string>} Set of existing negative keyword texts (lowercase)
 */
async function getExistingNegatives(customer, adGroupIds) {
  if (adGroupIds.length === 0) return new Set();

  const query = `
    SELECT
      ad_group_criterion.keyword.text,
      ad_group.id
    FROM ad_group_criterion
    WHERE ad_group.id IN (${adGroupIds.join(',')})
      AND ad_group_criterion.negative = true
      AND ad_group_criterion.type = 'KEYWORD'
  `;

  try {
    const results = await customer.query(query);
    const existing = new Set();
    for (const row of results) {
      const key = `${row.ad_group.id}:${row.ad_group_criterion.keyword.text.toLowerCase()}`;
      existing.add(key);
    }
    return existing;
  } catch (err) {
    console.warn('Warning: Could not fetch existing negatives:', err.message);
    return new Set();
  }
}

/**
 * Add negative keywords to ad groups in batches.
 * Replaces: createNegativeKeyword() calls
 *
 * @param {object} customer - Google Ads customer client
 * @param {Array} negatives - Array of { adGroupId, keyword, matchType }
 * @param {Set} existingNegatives - Set of existing negative keys to skip
 * @returns {{ added: number, skipped: number, errors: number }}
 */
async function addNegativeKeywords(customer, negatives, existingNegatives = new Set()) {
  let added = 0;
  let skipped = 0;
  let errors = 0;

  // Filter out duplicates
  const toAdd = negatives.filter(neg => {
    const key = `${neg.adGroupId}:${neg.keyword.toLowerCase()}`;
    if (existingNegatives.has(key)) {
      skipped++;
      return false;
    }
    return true;
  });

  // Process in batches of 5000 (Google Ads API limit)
  const batchSize = 5000;
  for (let i = 0; i < toAdd.length; i += batchSize) {
    const batch = toAdd.slice(i, i + batchSize);

    const operations = batch.map(neg => {
      const matchType = neg.matchType === 'broad' ? 'BROAD' : 'EXACT';
      const keywordText = neg.matchType === 'exact'
        ? neg.keyword // Exact match — API handles the brackets
        : neg.keyword;

      return {
        create: {
          ad_group: `customers/${customer.credentials.customer_id}/adGroups/${neg.adGroupId}`,
          negative: true,
          keyword: {
            text: keywordText,
            match_type: matchType,
          },
        },
      };
    });

    try {
      await customer.adGroupCriteria.create(operations);
      added += batch.length;
    } catch (err) {
      // Try individually on batch failure
      for (const op of operations) {
        try {
          await customer.adGroupCriteria.create([op]);
          added++;
        } catch (individualErr) {
          // Skip duplicate errors silently
          if (individualErr.message && individualErr.message.includes('DUPLICATE')) {
            skipped++;
          } else {
            errors++;
            console.error('Error adding negative keyword:', individualErr.message);
          }
        }
      }
    }
  }

  return { added, skipped, errors };
}

/**
 * Convert date range string to GAQL date clause.
 */
function getDateClause(dateRange) {
  const rangeMap = {
    'TODAY': 'DURING TODAY',
    'YESTERDAY': 'DURING YESTERDAY',
    'LAST_7_DAYS': 'DURING LAST_7_DAYS',
    'LAST_14_DAYS': 'DURING LAST_14_DAYS',
    'LAST_30_DAYS': 'DURING LAST_30_DAYS',
  };

  const clause = rangeMap[dateRange.toUpperCase()];
  if (clause) return `AND segments.date ${clause}`;

  // Default to today
  return 'AND segments.date DURING TODAY';
}

/**
 * Get Shopping campaigns by their IDs (for per-vendor configs).
 *
 * @param {object} customer - Google Ads customer client
 * @param {string[]} campaignIds - Array of campaign IDs
 * @returns {Array} Array of { campaignId, campaignName, adGroupId, adGroupName, tier }
 */
async function getShoppingCampaignsByIds(customer, campaignIds) {
  if (!campaignIds.length) return [];

  const query = `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      campaign.shopping_setting.campaign_priority
    FROM ad_group
    WHERE campaign.id IN (${campaignIds.join(',')})
      AND campaign.status != 'REMOVED'
      AND ad_group.status != 'REMOVED'
  `;

  const results = await customer.query(query);

  return results.map(row => {
    const tierMatch = row.campaign.name.match(/Tier\s*(\d)/i) || row.campaign.name.match(/(General|Brand|Product)/i);
    let tier = null;
    if (tierMatch) {
      const match = tierMatch[1] || tierMatch[0];
      if (match === 'General' || match === '1') tier = 1;
      else if (match === 'Brand' || match === '2') tier = 2;
      else if (match === 'Product' || match === '3') tier = 3;
      else tier = parseInt(match) || null;
    }

    return {
      campaignId: row.campaign.id.toString(),
      campaignName: row.campaign.name,
      adGroupId: row.ad_group.id.toString(),
      adGroupName: row.ad_group.name,
      tier,
    };
  });
}

// ============================================================
// ERROR FORMATTING
// ============================================================
/**
 * google-ads-api throws errors whose .message is often empty — the real
 * payload lives in err.errors[] (array of GoogleAdsError protos).
 * Flatten everything we can into a single log-and-UI-friendly string.
 */
function formatGoogleAdsError(err) {
  if (!err) return 'Unknown error';
  const parts = [];
  if (err.message && typeof err.message === 'string') parts.push(err.message);
  if (Array.isArray(err.errors)) {
    for (const e of err.errors) {
      const bits = [];
      if (e.message) bits.push(e.message);
      if (e.error_code) bits.push(`code=${JSON.stringify(e.error_code)}`);
      if (e.location?.field_path_elements) {
        bits.push(`field=${e.location.field_path_elements.map(f => f.field_name).join('.')}`);
      } else if (e.location) {
        bits.push(`loc=${JSON.stringify(e.location)}`);
      }
      if (e.trigger?.string_value) bits.push(`trigger="${e.trigger.string_value}"`);
      if (bits.length) parts.push(bits.join(' '));
    }
  }
  if (err.code !== undefined && !parts.length) parts.push(`grpc_code=${err.code}`);
  if (err.request_id) parts.push(`req=${err.request_id}`);
  if (!parts.length) {
    try {
      return JSON.stringify(err, Object.getOwnPropertyNames(err)).slice(0, 1200);
    } catch (_) {
      return String(err);
    }
  }
  return parts.join(' | ');
}

/**
 * Fetch existing ad-group-level criteria of a given type to dedupe before adding.
 * Returns Set of "adGroupId:criterionId:neg|pos" keys.
 */
async function getExistingAdGroupCriteria(customer, adGroupIds, type) {
  if (!adGroupIds.length) return new Set();
  const query = `
    SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.negative
    FROM ad_group_criterion
    WHERE ad_group.id IN (${adGroupIds.join(',')})
      AND ad_group_criterion.type = '${type}'
  `;
  try {
    const rows = await customer.query(query);
    const set = new Set();
    for (const r of rows) {
      set.add(`${r.ad_group.id}:${r.ad_group_criterion.criterion_id}:${r.ad_group_criterion.negative ? 'neg' : 'pos'}`);
    }
    return set;
  } catch (err) {
    console.warn(`getExistingAdGroupCriteria(${type}) failed:`, formatGoogleAdsError(err));
    return new Set();
  }
}

// ============================================================
// AUDIENCE OBSERVATIONS (in-market audiences, non-narrowing)
// ============================================================

/**
 * Attach user_interest criteria to ad groups in Observation mode.
 *
 * For Shopping, audiences (like income-range criteria) are written at
 * ad_group_criterion, not campaign_criterion. A non-negative ad_group_criterion
 * acts as Observation when the ad group's targeting_setting is OBSERVATION.
 *
 * @param {object} customer
 * @param {string} customerId
 * @param {string[]} adGroupIds
 * @param {string[]} audienceCriterionIds - numeric in-market audience IDs (strings)
 * @returns {{ added: number, skipped: number, errors: number, errorDetail?: string }}
 */
async function applyObservationAudiences(customer, customerId, adGroupIds, audienceCriterionIds) {
  if (!adGroupIds.length || !audienceCriterionIds.length) return { added: 0, skipped: 0, errors: 0 };

  const existing = await getExistingAdGroupCriteria(customer, adGroupIds, 'USER_INTEREST');

  const ops = [];
  let skipped = 0;
  for (const agid of adGroupIds) {
    for (const aid of audienceCriterionIds) {
      if (existing.has(`${agid}:${aid}:pos`)) { skipped++; continue; }
      ops.push({
        ad_group: `customers/${customerId}/adGroups/${agid}`,
        user_interest: { user_interest_category: `customers/${customerId}/userInterests/${aid}` },
      });
    }
  }

  if (!ops.length) return { added: 0, skipped, errors: 0 };

  try {
    await customer.adGroupCriteria.create(ops);
    return { added: ops.length, skipped, errors: 0 };
  } catch (err) {
    const detail = formatGoogleAdsError(err);
    console.warn('applyObservationAudiences failed:', detail);
    return { added: 0, skipped, errors: ops.length, errorDetail: detail };
  }
}

// ============================================================
// URL TRACKING HYGIENE AUDIT
// ============================================================

/**
 * List campaigns that have non-empty tracking_url_template or final_url_suffix.
 * These are usually stale UTM settings left behind from past agencies — safe to surface, not auto-clear.
 *
 * @returns {Array<{campaignId, campaignName, trackingUrlTemplate, finalUrlSuffix}>}
 */
async function getUrlTrackingIssues(customer) {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.tracking_url_template,
      campaign.final_url_suffix
    FROM campaign
    WHERE campaign.status != 'REMOVED'
  `;
  try {
    const rows = await customer.query(query);
    return rows
      .filter(r =>
        (r.campaign.tracking_url_template && r.campaign.tracking_url_template.length > 0) ||
        (r.campaign.final_url_suffix && r.campaign.final_url_suffix.length > 0)
      )
      .map(r => ({
        campaignId: r.campaign.id.toString(),
        campaignName: r.campaign.name,
        status: r.campaign.status,
        trackingUrlTemplate: r.campaign.tracking_url_template || '',
        finalUrlSuffix: r.campaign.final_url_suffix || '',
      }));
  } catch (err) {
    console.warn('getUrlTrackingIssues failed:', err.message);
    throw err;
  }
}

// ============================================================
// ACCOUNT-WIDE MOBILE APP BLOCK (CustomerNegativeCriterion)
// ============================================================

/**
 * Ensure an account-wide negative criterion exists for the given mobile-app category.
 * CustomerNegativeCriterion auto-applies to every campaign in the account, including PMax —
 * which SharedSet(NEGATIVE_KEYWORDS) cannot reach.
 *
 * Idempotent: checks for an existing criterion for the same category before adding.
 *
 * @param {object} customer
 * @param {string} mobileAppCategoryId - e.g. '69500' for the catch-all apps category
 * @returns {{ added: boolean, existed: boolean, resourceName: string | null, error?: string }}
 */
async function ensureMobileAppBlock(customer, mobileAppCategoryId) {
  const categoryRes = `mobileAppCategoryConstants/${mobileAppCategoryId}`;
  try {
    // Look for an existing matching criterion
    const rows = await customer.query(`
      SELECT
        customer_negative_criterion.resource_name,
        customer_negative_criterion.type,
        customer_negative_criterion.mobile_app_category.mobile_app_category_constant
      FROM customer_negative_criterion
      WHERE customer_negative_criterion.type = 'MOBILE_APP_CATEGORY'
    `);

    const existing = rows.find(r =>
      r.customer_negative_criterion?.mobile_app_category?.mobile_app_category_constant === categoryRes
    );

    if (existing) {
      return { added: false, existed: true, resourceName: existing.customer_negative_criterion.resource_name };
    }

    const response = await customer.customerNegativeCriteria.create([{
      mobile_app_category: { mobile_app_category_constant: categoryRes },
    }]);

    const resourceName = response?.results?.[0]?.resource_name || null;
    return { added: true, existed: false, resourceName };
  } catch (err) {
    const detail = formatGoogleAdsError(err);
    console.warn('ensureMobileAppBlock failed:', detail);
    return { added: false, existed: false, resourceName: null, error: detail };
  }
}

// ============================================================
// SHARED SET FOR MASTER/GENERAL NEGATIVES
// ============================================================

/**
 * Create (or return the existing) negative-keyword SharedSet for a client.
 * Returns the resource name so the caller can persist it.
 *
 * @param {object} customer
 * @param {string} name - Human-readable name, e.g. "ADS | Acme Co | Master Negatives"
 * @param {string} [existingResourceName] - If provided, used as-is (skip create).
 * @returns {{ resourceName: string, created: boolean }}
 */
async function ensureMasterSharedSet(customer, name, existingResourceName = null) {
  if (existingResourceName) {
    try {
      // Verify it still exists and isn't removed
      const rows = await customer.query(`
        SELECT shared_set.resource_name, shared_set.status
        FROM shared_set
        WHERE shared_set.resource_name = '${existingResourceName}'
      `);
      if (rows.length && rows[0].shared_set.status !== 'REMOVED') {
        return { resourceName: existingResourceName, created: false };
      }
    } catch (err) {
      console.warn('ensureMasterSharedSet verify failed, will recreate:', err.message);
    }
  }

  // Try to find by name first (e.g. manually created in UI)
  try {
    const rows = await customer.query(`
      SELECT shared_set.resource_name
      FROM shared_set
      WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
        AND shared_set.name = '${name.replace(/'/g, "\\'")}'
        AND shared_set.status != 'REMOVED'
    `);
    if (rows.length) {
      return { resourceName: rows[0].shared_set.resource_name, created: false };
    }
  } catch (err) {
    console.warn('sharedSet name lookup failed:', err.message);
  }

  // Create it
  const response = await customer.sharedSets.create([{
    name,
    type: 'NEGATIVE_KEYWORDS',
  }]);
  const resourceName = response?.results?.[0]?.resource_name;
  if (!resourceName) throw new Error('Failed to create SharedSet');
  return { resourceName, created: true };
}

/**
 * Reconcile a SharedSet's SharedCriteria with the desired list.
 * Adds missing entries and removes ones that no longer belong.
 *
 * Desired format: [{ keyword: 'used', matchType: 'phrase' }, ...]
 * matchType: 'exact' | 'phrase' | 'broad' (lowercase in DB, uppercased for API)
 *
 * @returns {{ added: number, removed: number, skipped: number, errors: number }}
 */
async function syncMasterSharedSetCriteria(customer, sharedSetResourceName, desired) {
  if (!sharedSetResourceName) throw new Error('sharedSetResourceName is required');

  // Build a canonical key for a criterion: "text||MATCH_TYPE"
  const keyFor = (text, matchType) => `${text.toLowerCase()}||${String(matchType).toUpperCase()}`;

  const desiredMap = new Map();
  for (const d of desired) {
    const text = (d.keyword || '').trim();
    if (!text) continue;
    const mt = (d.matchType || d.match_type || 'phrase').toUpperCase();
    desiredMap.set(keyFor(text, mt), { text, matchType: mt });
  }

  // Load what's currently in the shared set. If the SharedSet was deleted
  // in the Google Ads UI, this query throws RESOURCE_NOT_FOUND — tag it so
  // callers can catch and auto-recreate via ensureMasterSharedSet(..., null).
  let rows;
  try {
    rows = await customer.query(`
      SELECT
        shared_criterion.resource_name,
        shared_criterion.type,
        shared_criterion.keyword.text,
        shared_criterion.keyword.match_type
      FROM shared_criterion
      WHERE shared_set.resource_name = '${sharedSetResourceName}'
        AND shared_criterion.type = 'KEYWORD'
    `);
  } catch (err) {
    const tagged = new Error(`SharedSet missing or inaccessible (${sharedSetResourceName}): ${formatGoogleAdsError(err)}`);
    tagged.code = 'SHARED_SET_NOT_FOUND';
    tagged.cause = err;
    throw tagged;
  }

  const existingMap = new Map();
  for (const r of rows) {
    const text = r.shared_criterion.keyword?.text;
    const mt = r.shared_criterion.keyword?.match_type;
    if (!text || !mt) continue;
    existingMap.set(keyFor(text, mt), r.shared_criterion.resource_name);
  }

  // Compute diffs
  const toAdd = [];
  for (const [key, val] of desiredMap) {
    if (!existingMap.has(key)) {
      toAdd.push({
        shared_set: sharedSetResourceName,
        keyword: { text: val.text, match_type: val.matchType },
      });
    }
  }

  const toRemove = [];
  for (const [key, resourceName] of existingMap) {
    if (!desiredMap.has(key)) toRemove.push(resourceName);
  }

  let added = 0, removed = 0, errors = 0;
  const errorDetails = [];

  // Chunk size: Google Ads caps mutate operations per request — 1000 is the
  // historical safe limit for shared_criterion. Each chunk is independently
  // try/catched so a partial failure doesn't abandon remaining chunks.
  const CHUNK = 1000;

  if (toAdd.length) {
    for (let i = 0; i < toAdd.length; i += CHUNK) {
      const slice = toAdd.slice(i, i + CHUNK);
      try {
        await customer.sharedCriteria.create(slice);
        added += slice.length;
      } catch (err) {
        const detail = formatGoogleAdsError(err);
        console.warn(`syncMasterSharedSetCriteria add chunk ${i / CHUNK + 1} failed (${slice.length} ops):`, detail);
        errors += slice.length;
        errorDetails.push(`add[${i}..${i + slice.length}]: ${detail}`);
      }
    }
  }

  if (toRemove.length) {
    for (let i = 0; i < toRemove.length; i += CHUNK) {
      const slice = toRemove.slice(i, i + CHUNK);
      try {
        await customer.sharedCriteria.remove(slice);
        removed += slice.length;
      } catch (err) {
        const detail = formatGoogleAdsError(err);
        console.warn(`syncMasterSharedSetCriteria remove chunk ${i / CHUNK + 1} failed (${slice.length} ops):`, detail);
        errors += slice.length;
        errorDetails.push(`remove[${i}..${i + slice.length}]: ${detail}`);
      }
    }
  }

  return {
    added,
    removed,
    skipped: desiredMap.size - added,
    errors,
    total: desiredMap.size,
    errorDetail: errorDetails.length ? errorDetails.join(' | ') : undefined,
  };
}

/**
 * Attach a SharedSet to one or more campaigns. Idempotent — skips already-attached pairs.
 * @returns {{ attached: number, skipped: number }}
 */
async function attachSharedSetToCampaigns(customer, sharedSetResourceName, campaignResourceNames) {
  if (!campaignResourceNames.length) return { attached: 0, skipped: 0 };

  // Load existing attachments for these campaigns
  const campIdList = campaignResourceNames
    .map(r => r.split('/').pop())
    .join(',');

  const existing = new Set();
  try {
    const rows = await customer.query(`
      SELECT
        campaign_shared_set.campaign,
        campaign_shared_set.shared_set,
        campaign_shared_set.status
      FROM campaign_shared_set
      WHERE campaign.id IN (${campIdList})
    `);
    for (const r of rows) {
      if (r.campaign_shared_set.status !== 'REMOVED') {
        existing.add(`${r.campaign_shared_set.campaign}||${r.campaign_shared_set.shared_set}`);
      }
    }
  } catch (err) {
    console.warn('attachSharedSet lookup failed:', err.message);
  }

  const ops = [];
  let skipped = 0;
  for (const camp of campaignResourceNames) {
    const key = `${camp}||${sharedSetResourceName}`;
    if (existing.has(key)) { skipped++; continue; }
    ops.push({ campaign: camp, shared_set: sharedSetResourceName });
  }

  if (!ops.length) return { attached: 0, skipped };

  await customer.campaignSharedSets.create(ops);
  return { attached: ops.length, skipped };
}

// ============================================================
// CAMPAIGN-LEVEL NEGATIVE KEYWORDS
// ============================================================
// Direct negatives on a single campaign (campaign_criterion with negative=TRUE).
// Used for per-vendor Brand / Product keyword lists — each list lives on
// exactly one campaign, so the SharedSet indirection isn't worth it.
// Google's per-campaign negative-keyword cap is 10,000, and the standard
// mutate batch is 5000 ops — a ~3K keyword list lands in a single request.

/**
 * Reconcile one campaign's negative keywords against a desired list.
 * Diff-add / remove, idempotent. Chunked at 5000 ops per mutate request
 * (Google's standard campaign_criterion batch limit — a ~3K list fits in 1).
 * Per-chunk try/catch so a partial failure doesn't abandon remaining chunks.
 *
 * @param {object} customer - google-ads-api customer client
 * @param {string} campaignResourceName - e.g. 'customers/123/campaigns/456'
 * @param {Array<{keyword: string, matchType?: string, match_type?: string}>} desired
 * @param {string} defaultMatchType - 'BROAD' | 'PHRASE' | 'EXACT'
 * @returns {{ added, removed, skipped, total, errors, errorDetail }}
 */
async function syncCampaignNegativeKeywords(customer, campaignResourceName, desired, defaultMatchType = 'BROAD') {
  if (!campaignResourceName) throw new Error('campaignResourceName is required');
  const defaultMt = String(defaultMatchType || 'BROAD').toUpperCase();

  const keyFor = (text, matchType) => `${text.toLowerCase()}||${String(matchType).toUpperCase()}`;

  const desiredMap = new Map();
  for (const d of (desired || [])) {
    const text = (d.keyword || '').trim();
    if (!text) continue;
    const mt = (d.matchType || d.match_type || defaultMt).toUpperCase();
    desiredMap.set(keyFor(text, mt), { text, matchType: mt });
  }

  // Load existing negative keyword criteria on this campaign
  const campIdStr = campaignResourceName.split('/').pop();
  const rows = await customer.query(`
    SELECT
      campaign_criterion.resource_name,
      campaign_criterion.keyword.text,
      campaign_criterion.keyword.match_type,
      campaign_criterion.negative,
      campaign_criterion.type
    FROM campaign_criterion
    WHERE campaign.id = ${campIdStr}
      AND campaign_criterion.type = 'KEYWORD'
      AND campaign_criterion.negative = TRUE
  `);

  const existingMap = new Map();
  for (const r of rows) {
    const text = r.campaign_criterion.keyword?.text;
    const mt = r.campaign_criterion.keyword?.match_type;
    if (!text || !mt) continue;
    existingMap.set(keyFor(text, mt), r.campaign_criterion.resource_name);
  }

  // Diff
  const toAdd = [];
  for (const [key, val] of desiredMap) {
    if (!existingMap.has(key)) {
      toAdd.push({
        campaign: campaignResourceName,
        negative: true,
        keyword: { text: val.text, match_type: val.matchType },
      });
    }
  }
  const toRemove = [];
  for (const [key, resourceName] of existingMap) {
    if (!desiredMap.has(key)) toRemove.push(resourceName);
  }

  let added = 0, removed = 0, errors = 0;
  const errorDetails = [];
  const CHUNK = 5000;

  if (toAdd.length) {
    for (let i = 0; i < toAdd.length; i += CHUNK) {
      const slice = toAdd.slice(i, i + CHUNK);
      try {
        await customer.campaignCriteria.create(slice);
        added += slice.length;
      } catch (err) {
        const detail = formatGoogleAdsError(err);
        console.warn(`syncCampaignNegativeKeywords add chunk ${i / CHUNK + 1} failed (${slice.length} ops) for ${campaignResourceName}:`, detail);
        errors += slice.length;
        errorDetails.push(`add[${i}..${i + slice.length}]: ${detail}`);
      }
    }
  }

  if (toRemove.length) {
    for (let i = 0; i < toRemove.length; i += CHUNK) {
      const slice = toRemove.slice(i, i + CHUNK);
      try {
        await customer.campaignCriteria.remove(slice);
        removed += slice.length;
      } catch (err) {
        const detail = formatGoogleAdsError(err);
        console.warn(`syncCampaignNegativeKeywords remove chunk ${i / CHUNK + 1} failed (${slice.length} ops) for ${campaignResourceName}:`, detail);
        errors += slice.length;
        errorDetails.push(`remove[${i}..${i + slice.length}]: ${detail}`);
      }
    }
  }

  return {
    added,
    removed,
    skipped: desiredMap.size - added,
    total: desiredMap.size,
    errors,
    errorDetail: errorDetails.length ? errorDetails.join(' | ') : undefined,
  };
}

// ============================================================
// WATERFALL NEGATIVES ORCHESTRATORS
// ============================================================
// Two levels:
//   1. Master Negatives — one SharedSet per CLIENT (general_negatives), attached
//      to every tracked campaign on that client. (Still SharedSet because it IS
//      shared across 3×N campaigns — the indirection pays for itself.)
//   2. Brand + Product Keywords — direct CampaignCriterion negatives on each
//      vendor's campaigns per the waterfall:
//        Brand keywords   → attached to campaigns where blocks_brand=TRUE
//                           (the vendor's Product-tier campaign)
//        Product keywords → attached to campaigns where blocks_product=TRUE
//                           (the vendor's Brand-tier campaign)
//
// All steps are idempotent.

/**
 * Sync the client-wide Master Negatives SharedSet + attach to every tracked campaign.
 * Self-heals if the SharedSet was deleted in the Google Ads UI (catches the
 * tagged SHARED_SET_NOT_FOUND error and retries once with a fresh SharedSet).
 *
 * @returns {{ resourceName, created, added, removed, skipped, total, errors, attached, attachSkipped, errorDetail?, recovered? }}
 */
async function syncMasterNegativesForClient(customer, customerId, client, generalNegatives, allCampaignIds) {
  const name = masterNegativesSharedSetName(await getCampaignPrefix(), client.name);
  const toResource = (cid) => `customers/${customerId}/campaigns/${cid}`;

  async function attempt(existingResourceName) {
    const { resourceName, created } = await ensureMasterSharedSet(
      customer, name, existingResourceName
    );
    const syncStats = await syncMasterSharedSetCriteria(customer, resourceName, generalNegatives || []);
    const attachStats = allCampaignIds.length
      ? await attachSharedSetToCampaigns(customer, resourceName, allCampaignIds.map(toResource))
      : { attached: 0, skipped: 0 };
    return { resourceName, created, syncStats, attachStats };
  }

  let recovered = false;
  try {
    let result;
    try {
      result = await attempt(client.master_shared_set_resource_name);
    } catch (err) {
      if (err && err.code === 'SHARED_SET_NOT_FOUND') {
        console.warn(`[${client.name}] Master SharedSet missing — recreating`);
        recovered = true;
        result = await attempt(null);
      } else {
        throw err;
      }
    }
    return {
      resourceName: result.resourceName,
      created: result.created,
      added: result.syncStats.added,
      removed: result.syncStats.removed,
      skipped: result.syncStats.skipped,
      total: result.syncStats.total,
      errors: result.syncStats.errors,
      errorDetail: result.syncStats.errorDetail,
      attached: result.attachStats.attached,
      attachSkipped: result.attachStats.skipped,
      recovered,
    };
  } catch (err) {
    return {
      resourceName: client.master_shared_set_resource_name || null,
      created: false,
      added: 0, removed: 0, skipped: 0, total: 0, errors: 1,
      attached: 0, attachSkipped: 0,
      errorDetail: formatGoogleAdsError(err),
      recovered,
    };
  }
}

/**
 * Force-rebuild the client's Master Negatives SharedSet — ignore any cached
 * resource name and create a fresh set. Used by the "Rebuild" button for when
 * someone deleted the set in the Google Ads UI and the big-red-button override
 * is preferred over waiting for self-heal on next Sync.
 *
 * @returns same shape as syncMasterNegativesForClient
 */
async function rebuildMasterSharedSet(customer, customerId, client, generalNegatives, allCampaignIds) {
  const name = masterNegativesSharedSetName(await getCampaignPrefix(), client.name);
  const toResource = (cid) => `customers/${customerId}/campaigns/${cid}`;
  try {
    // Pass null to skip the cached-resource check and either find by name or create new
    const { resourceName, created } = await ensureMasterSharedSet(customer, name, null);
    const syncStats = await syncMasterSharedSetCriteria(customer, resourceName, generalNegatives || []);
    const attachStats = allCampaignIds.length
      ? await attachSharedSetToCampaigns(customer, resourceName, allCampaignIds.map(toResource))
      : { attached: 0, skipped: 0 };
    return {
      resourceName,
      created,
      added: syncStats.added,
      removed: syncStats.removed,
      skipped: syncStats.skipped,
      total: syncStats.total,
      errors: syncStats.errors,
      errorDetail: syncStats.errorDetail,
      attached: attachStats.attached,
      attachSkipped: attachStats.skipped,
      rebuilt: true,
    };
  } catch (err) {
    return {
      resourceName: null,
      created: false,
      added: 0, removed: 0, skipped: 0, total: 0, errors: 1,
      attached: 0, attachSkipped: 0,
      errorDetail: formatGoogleAdsError(err),
      rebuilt: false,
    };
  }
}

/**
 * Sync a single vendor's Brand + Product negative keywords directly onto the
 * vendor's campaigns (CampaignCriterion with negative=TRUE).
 *
 * Brand keywords   → campaigns where blocks_brand=TRUE   (Product-tier campaign)
 * Product keywords → campaigns where blocks_product=TRUE (Brand-tier campaign)
 *
 * @param customer       — google-ads-api customer
 * @param customerId     — unformatted customer ID string
 * @param vendorName     — used only for logging
 * @param brandKeywords  — [{ keyword, match_type }] for this vendor
 * @param productKeywords— [{ keyword, match_type }] for this vendor
 * @param vendorConfigs  — campaign_configs filtered to this vendor (rows with google_campaign_id, blocks_brand, blocks_product)
 *
 * @returns { brand: {...}, product: {...} } — each object same shape as syncCampaignNegativeKeywords
 */
async function syncVendorNegatives(customer, customerId, vendorName, brandKeywords, productKeywords, vendorConfigs) {
  const configs = vendorConfigs || [];
  const brandCampaignIds = [...new Set(configs
    .filter(c => c.google_campaign_id && c.blocks_brand)
    .map(c => c.google_campaign_id))];
  const productCampaignIds = [...new Set(configs
    .filter(c => c.google_campaign_id && c.blocks_product)
    .map(c => c.google_campaign_id))];

  async function runOne(desiredList, campaignIds, kind) {
    // Aggregate across all target campaigns (normally just 1 per kind)
    const totals = {
      added: 0, removed: 0, skipped: 0, total: 0, errors: 0,
      // UI compat: the old shape had these; keep them zero for campaign-level
      attached: 0, attachSkipped: 0,
      // New: which campaign(s) we wrote to
      campaignIds: campaignIds.slice(),
    };
    const errorDetails = [];

    if (!campaignIds.length) return totals;

    for (const cid of campaignIds) {
      const campaignResourceName = `customers/${customerId}/campaigns/${cid}`;
      try {
        const r = await syncCampaignNegativeKeywords(customer, campaignResourceName, desiredList || [], 'BROAD');
        totals.added += r.added;
        totals.removed += r.removed;
        totals.skipped = Math.max(totals.skipped, r.skipped);
        totals.total = Math.max(totals.total, r.total);
        totals.errors += r.errors;
        if (r.errorDetail) errorDetails.push(`campaign ${cid}: ${r.errorDetail}`);
      } catch (err) {
        const detail = formatGoogleAdsError(err);
        console.warn(`[${vendorName}] ${kind} sync failed for campaign ${cid}:`, detail);
        totals.errors += 1;
        errorDetails.push(`campaign ${cid}: ${detail}`);
      }
    }

    if (errorDetails.length) totals.errorDetail = errorDetails.join(' | ');
    return totals;
  }

  const [brand, product] = await Promise.all([
    runOne(brandKeywords, brandCampaignIds, 'brand'),
    runOne(productKeywords, productCampaignIds, 'product'),
  ]);

  return { brand, product };
}

module.exports = {
  createAdsClient,
  getShoppingCampaigns,
  getShoppingCampaignsByIds,
  getSearchQueries,
  getExistingNegatives,
  addNegativeKeywords,
  applyObservationAudiences,
  getUrlTrackingIssues,
  ensureMobileAppBlock,
  ensureMasterSharedSet,
  syncMasterSharedSetCriteria,
  attachSharedSetToCampaigns,
  syncCampaignNegativeKeywords,
  syncMasterNegativesForClient,
  rebuildMasterSharedSet,
  syncVendorNegatives,
  formatGoogleAdsError,
};
