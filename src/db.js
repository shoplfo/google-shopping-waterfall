const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

// Service role client (bypasses RLS — for engine and admin operations)
const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// Anon client (respects RLS — for client-facing queries)
const supabaseAnon = createClient(config.supabase.url, config.supabase.anonKey);

module.exports = { supabase, supabaseAnon };
