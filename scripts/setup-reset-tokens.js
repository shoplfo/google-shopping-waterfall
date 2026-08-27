/**
 * Creates the password_reset_tokens table in Supabase.
 * Run once: node scripts/setup-reset-tokens.js
 *
 * Uses the Supabase Management API since the JS client can't run raw SQL.
 * As a workaround, we try to insert into the table — if it doesn't exist,
 * the forgot-password endpoint will fail gracefully. To create the table,
 * paste sql/migration-v8.sql into the Supabase SQL Editor.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function setup() {
  // Test if the table exists
  const { data, error } = await supabase
    .from('password_reset_tokens')
    .select('id')
    .limit(1);

  if (error && error.code === 'PGRST205') {
    console.log('password_reset_tokens table does NOT exist.');
    console.log('Please run sql/migration-v8.sql in the Supabase SQL Editor:');
    console.log('  https://supabase.com/dashboard/project/_/sql/new');
    console.log('\nSQL to run:');
    const fs = require('fs');
    const sql = fs.readFileSync('sql/migration-v8.sql', 'utf8');
    console.log(sql);
  } else if (error) {
    console.log('Error checking table:', error.message);
  } else {
    console.log('password_reset_tokens table exists! Rows:', data.length);
  }

  // Also verify users table
  const { data: users, error: ue } = await supabase.from('users').select('email, name, role');
  if (ue) {
    console.log('Users table error:', ue.message);
  } else {
    console.log('Users:', users.map(u => `${u.email} (${u.role})`).join(', '));
  }
}

setup();
