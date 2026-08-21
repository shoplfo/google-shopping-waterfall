const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const router = express.Router();
const config = require('../config');
const { requireApiKey, requirePermission } = require('../middleware/auth');
const { supabase } = require('../db');

// In-memory CSRF token store (single-server deployment)
const csrfTokens = new Map();

function storeCsrf(token) {
  csrfTokens.set(token, Date.now());
  // Clean up expired tokens (>10 min)
  for (const [t, ts] of csrfTokens) {
    if (Date.now() - ts > 600000) csrfTokens.delete(t);
  }
}

function validateAndConsumeCsrf(token) {
  if (!csrfTokens.has(token)) return false;
  const ts = csrfTokens.get(token);
  csrfTokens.delete(token);
  return (Date.now() - ts) < 600000;
}

function createOAuth2Client(callbackUrl) {
  return new google.auth.OAuth2(
    config.googleAds.clientId,
    config.googleAds.clientSecret,
    callbackUrl || config.googleAds.oauthCallbackUrl
  );
}

/**
 * Build the OAuth callback URL from the current request.
 * Uses OAUTH_CALLBACK_URL env var if set, otherwise derives from request origin.
 */
function getCallbackUrl(req) {
  if (process.env.OAUTH_CALLBACK_URL) return process.env.OAUTH_CALLBACK_URL;
  const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/oauth/google/callback`;
}

// GET /api/oauth/google/start?clientId=<uuid> — Generate consent URL (agency+)
router.get('/google/start', requireApiKey, requirePermission('connect_google_ads'), async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) {
      return res.status(400).json({ error: 'clientId query parameter is required' });
    }

    // Verify client exists
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, name')
      .eq('id', clientId)
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const callbackUrl = getCallbackUrl(req);
    const oauth2Client = createOAuth2Client(callbackUrl);
    const csrf = crypto.randomBytes(32).toString('hex');
    storeCsrf(csrf);

    const state = Buffer.from(JSON.stringify({ clientId, csrf, callbackUrl })).toString('base64');

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/adwords'],
      state,
    });

    res.json({ url });
  } catch (err) {
    console.error('OAuth start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/oauth/google/callback — Handle Google's redirect (no API key)
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect(`/?oauth=error&message=${encodeURIComponent(oauthError)}`);
    }

    if (!code || !state) {
      return res.redirect('/?oauth=error&message=Missing+code+or+state');
    }

    // Decode and validate state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch {
      return res.redirect('/?oauth=error&message=Invalid+state+parameter');
    }

    const { clientId, csrf, callbackUrl } = stateData;

    if (!validateAndConsumeCsrf(csrf)) {
      return res.redirect('/?oauth=error&message=Invalid+or+expired+CSRF+token');
    }

    // Exchange code for tokens — must use the same redirect_uri as the /start request
    const oauth2Client = createOAuth2Client(callbackUrl || getCallbackUrl(req));
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      return res.redirect('/?oauth=error&message=No+refresh+token+received.+Try+again.');
    }

    // Save refresh token to client record
    const { error: updateError } = await supabase
      .from('clients')
      .update({ oauth_refresh_token: tokens.refresh_token })
      .eq('id', clientId);

    if (updateError) {
      console.error('Failed to save refresh token:', updateError);
      return res.redirect('/?oauth=error&message=Failed+to+save+token');
    }

    res.redirect(`/?oauth=success&clientId=${clientId}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect(`/?oauth=error&message=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/oauth/google/accounts?clientId=<uuid> — List accessible Google Ads accounts
router.get('/google/accounts', requireApiKey, async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    // Get client's refresh token
    const { data: client, error } = await supabase
      .from('clients')
      .select('id, oauth_refresh_token')
      .eq('id', clientId)
      .single();

    if (error || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (!client.oauth_refresh_token) {
      return res.status(400).json({ error: 'Client has no OAuth token. Connect Google Ads first.' });
    }

    // Try to list accessible customers via google-ads-api
    const { GoogleAdsApi } = require('google-ads-api');
    const adsClient = new GoogleAdsApi({
      client_id: config.googleAds.clientId,
      client_secret: config.googleAds.clientSecret,
      developer_token: config.googleAds.developerToken,
    });

    let resourceNames = [];
    try {
      const result = await adsClient.listAccessibleCustomers(client.oauth_refresh_token);
      resourceNames = result.resource_names || [];
    } catch (e) {
      console.warn('listAccessibleCustomers failed (dev token may be test-only):', e.message);
      // Return empty — dashboard will fall back to manual CID entry
      return res.json([]);
    }

    if (!resourceNames.length) {
      return res.json([]);
    }

    // Fetch details for each accessible account
    const accounts = [];
    for (const resourceName of resourceNames) {
      const custId = resourceName.replace('customers/', '');
      try {
        const custClient = adsClient.Customer({
          customer_id: custId,
          refresh_token: client.oauth_refresh_token,
        });
        const [result] = await custClient.query(`
          SELECT customer.id, customer.descriptive_name, customer.manager
          FROM customer LIMIT 1
        `);
        accounts.push({
          id: custId,
          name: result.customer.descriptive_name || custId,
          is_manager: result.customer.manager || false,
          formatted_id: custId.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3'),
        });
      } catch (e) {
        accounts.push({
          id: custId,
          name: custId,
          is_manager: false,
          formatted_id: custId.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3'),
        });
      }
    }

    res.json(accounts);
  } catch (err) {
    console.error('List accounts error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
