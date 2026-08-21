const { supabase } = require('../db');
const { processClient } = require('./processor');

/**
 * Run the engine for all active clients.
 * Called by the cron job or manual trigger.
 *
 * @returns {object} Summary of all client runs
 */
async function runAll({ skipCronCheck = false } = {}) {
  const startTime = new Date();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Engine dispatch started at ${startTime.toISOString()}`);
  console.log(`${'='.repeat(60)}\n`);

  // Honor the global cron_enabled toggle (admins can pause scheduled runs without redeploying).
  // Manual triggers pass skipCronCheck=true so they bypass this.
  if (!skipCronCheck) {
    const { data: settings } = await supabase
      .from('app_settings')
      .select('cron_enabled')
      .eq('id', 1)
      .maybeSingle();
    if (settings && settings.cron_enabled === false) {
      console.log('Cron is disabled in app_settings. Skipping run.');
      return { success: true, clientsProcessed: 0, results: [], skipped: true };
    }
  }

  // Load all active clients
  const { data: clients, error } = await supabase
    .from('clients')
    .select('*')
    .eq('is_active', true)
    .order('name');

  if (error) {
    console.error('Failed to load clients:', error.message);
    return { success: false, error: error.message };
  }

  if (!clients || clients.length === 0) {
    console.log('No active clients found.');
    return { success: true, clientsProcessed: 0, results: [] };
  }

  console.log(`Found ${clients.length} active client(s). Processing sequentially...\n`);

  const results = [];

  for (const client of clients) {
    console.log(`--- Processing: ${client.name} (${client.google_ads_customer_id}) ---`);
    try {
      const result = await processClient(client);
      results.push({
        clientId: client.id,
        clientName: client.name,
        ...result,
      });
    } catch (err) {
      console.error(`[${client.name}] Unexpected error:`, err.message);
      results.push({
        clientId: client.id,
        clientName: client.name,
        success: false,
        error: err.message,
      });
    }
    console.log('');
  }

  const endTime = new Date();
  const durationMs = endTime - startTime;
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;

  console.log(`${'='.repeat(60)}`);
  console.log(`Engine dispatch completed in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Results: ${successCount} succeeded, ${failCount} failed out of ${clients.length} clients`);
  console.log(`${'='.repeat(60)}\n`);

  return {
    success: failCount === 0,
    clientsProcessed: clients.length,
    succeeded: successCount,
    failed: failCount,
    durationMs,
    results,
  };
}

/**
 * Run the engine for a single client by ID.
 * Used for manual triggers.
 *
 * @param {string} clientId - Client UUID
 * @returns {object} Run result
 */
async function runOne(clientId) {
  const { data: client, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', clientId)
    .single();

  if (error || !client) {
    return { success: false, error: 'Client not found' };
  }

  console.log(`Manual run triggered for: ${client.name}`);
  return processClient(client);
}

module.exports = { runAll, runOne };
