const { TIER_CONFIG } = require('./campaignManager');
const { DEFAULT_PREFIX, campaignName: buildCampaignName } = require('../naming');

const PRIORITY_MAP = { 2: 'High', 1: 'Medium', 0: 'Low' };

const CSV_COLUMNS = [
  'Campaign',
  'Campaign Type',
  'Campaign Status',
  'Budget',
  'Budget type',
  'Bid Strategy Type',
  'Campaign Priority',
  'Merchant Identifier',
  'Sales Country',
  'Ad Group',
  'Ad Group Type',
  'Max CPC',
  'Ad Group Status',
];

function escapeCSV(val) {
  if (val === null || val === undefined || val === '') return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Generate a Google Ads Editor-compatible CSV for campaign import.
 *
 * @param {Array<{vendorName: string, merchantId: string}>} vendorConfigs
 * @param {number} budgetDollars - Daily budget per campaign (default 50)
 * @returns {string} CSV string
 */
function generateEditorCSV(vendorConfigs, budgetDollars = 50, prefix = DEFAULT_PREFIX) {
  const rows = [CSV_COLUMNS.map(escapeCSV).join(',')];

  for (const { vendorName, merchantId } of vendorConfigs) {
    for (const tier of TIER_CONFIG) {
      const campaignName = buildCampaignName(prefix, vendorName, tier.name);
      const cpcDollars = (tier.cpcMicros / 1_000_000).toFixed(2);

      // Campaign row
      rows.push([
        escapeCSV(campaignName),          // Campaign
        'Shopping',                        // Campaign Type
        'Paused',                          // Campaign Status
        budgetDollars.toFixed(2),          // Budget
        'Daily',                           // Budget type
        'Manual CPC',                      // Bid Strategy Type
        PRIORITY_MAP[tier.priority],       // Campaign Priority
        escapeCSV(merchantId),             // Merchant Identifier
        'US',                              // Sales Country
        '',                                // Ad Group
        '',                                // Ad Group Type
        '',                                // Max CPC
        '',                                // Ad Group Status
      ].join(','));

      // Ad Group row
      rows.push([
        escapeCSV(campaignName),          // Campaign
        '',                                // Campaign Type
        '',                                // Campaign Status
        '',                                // Budget
        '',                                // Budget type
        '',                                // Bid Strategy Type
        '',                                // Campaign Priority
        '',                                // Merchant Identifier
        '',                                // Sales Country
        escapeCSV(campaignName),          // Ad Group (same name as campaign)
        'Shopping Product Ads',            // Ad Group Type
        cpcDollars,                        // Max CPC
        'Enabled',                         // Ad Group Status
      ].join(','));
    }
  }

  return rows.join('\n');
}

module.exports = { generateEditorCSV };
