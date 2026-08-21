/**
 * Campaign / SharedSet naming.
 *
 * Every name this app creates in Google Ads flows through here so the prefix
 * is configurable instead of hardcoded to one advertiser's brand.
 *
 * Naming convention:
 *   Campaign  : "{PREFIX} | {Vendor} | Shopping | {General|Brand|Product}"
 *   Budget    : "{PREFIX} | {Vendor} | Shopping | Budget"
 *   SharedSet : "{PREFIX} | {Client} | Master Negatives"
 *
 * The prefix comes from app_settings.campaign_name_prefix (migration v18).
 * Changing it only affects campaigns created afterwards — existing campaigns
 * in Google Ads keep the name they were created with.
 */

const { supabase } = require('./db');

const DEFAULT_PREFIX = 'ADS';

// Cache the prefix briefly so a bulk campaign-creation run doesn't hit the DB
// once per name. Short TTL so a settings change takes effect quickly.
let _cache = { value: null, at: 0 };
const CACHE_MS = 30_000;

/**
 * Read the configured campaign name prefix. Falls back to DEFAULT_PREFIX if
 * app_settings is unreachable or the column is empty — naming should never be
 * the thing that breaks a campaign build.
 *
 * @returns {Promise<string>}
 */
async function getCampaignPrefix() {
  const now = Date.now();
  if (_cache.value && (now - _cache.at) < CACHE_MS) return _cache.value;

  try {
    const { data } = await supabase
      .from('app_settings')
      .select('campaign_name_prefix')
      .eq('id', 1)
      .maybeSingle();
    const prefix = (data?.campaign_name_prefix || '').trim() || DEFAULT_PREFIX;
    _cache = { value: prefix, at: now };
    return prefix;
  } catch (err) {
    console.warn('getCampaignPrefix failed, using default:', err.message);
    return DEFAULT_PREFIX;
  }
}

/** Clear the cache — call after updating the setting so the next read is fresh. */
function clearPrefixCache() {
  _cache = { value: null, at: 0 };
}

/** "{prefix} | {vendor} | Shopping | {tierName}" */
function campaignName(prefix, vendorName, tierName) {
  return `${prefix} | ${vendorName} | Shopping | ${tierName}`;
}

/** Ad groups mirror their campaign's name. */
function adGroupName(prefix, vendorName, tierName) {
  return campaignName(prefix, vendorName, tierName);
}

/** "{prefix} | {vendor} | Shopping | Budget" */
function budgetName(prefix, vendorName) {
  return `${prefix} | ${vendorName} | Shopping | Budget`;
}

/** "{prefix} | {client} | Master Negatives" */
function masterNegativesSharedSetName(prefix, clientName) {
  return `${prefix} | ${clientName} | Master Negatives`;
}

module.exports = {
  DEFAULT_PREFIX,
  getCampaignPrefix,
  clearPrefixCache,
  campaignName,
  adGroupName,
  budgetName,
  masterNegativesSharedSetName,
};
