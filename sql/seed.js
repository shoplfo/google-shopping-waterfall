#!/usr/bin/env node
/**
 * Seed script — loads master keywords and general negatives via the API.
 *
 * Usage:
 *   API_KEY=your-api-secret-key node sql/seed.js --all
 *   API_KEY=your-api-secret-key node sql/seed.js --negatives
 *
 * Files loaded:
 *   --negatives  sql/seed-general-negatives.json
 *                86 vertical-neutral negatives (jobs, used, rental, DIY,
 *                wholesale, research intent). Safe for any retailer.
 *
 *   --master     sql/seed-master-keywords.json
 *                Your product-category terms. This file is NOT in the repo —
 *                master keywords depend entirely on what you sell. See
 *                seed-master-keywords.furniture-example.json for the format.
 *
 * Override either path:
 *   MASTER_KEYWORDS_FILE=./my-keywords.json
 *   GENERAL_NEGATIVES_FILE=./my-negatives.json
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('Missing API_KEY environment variable.');
  console.error('Set it to the same value as API_SECRET_KEY in your .env, e.g.:');
  console.error('  API_KEY=your-api-secret-key node sql/seed.js --all');
  process.exit(1);
}

const args = process.argv.slice(2);
const seedMaster = args.includes('--master') || args.includes('--all') || args.length === 0;
const seedNegatives = args.includes('--negatives') || args.includes('--all') || args.length === 0;

async function postBatch(endpoint, keywords) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ keywords }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status}: ${err}`);
  }
  return res.json();
}

async function main() {
  console.log(`Seeding database at ${API_BASE}\n`);

  if (seedMaster) {
    const file = process.env.MASTER_KEYWORDS_FILE
      ? path.resolve(process.env.MASTER_KEYWORDS_FILE)
      : path.join(__dirname, 'seed-master-keywords.json');

    if (!fs.existsSync(file)) {
      // Master keywords are inherently industry-specific, so the repo ships no
      // default list. Skip rather than fail — the negatives seed still runs.
      console.log(`Master keywords: skipped — no file at ${file}`);
      console.log('  This repo ships no default master-keyword list (it depends on what you sell).');
      console.log('  Create sql/seed-master-keywords.json — see seed-master-keywords.furniture-example.json');
      console.log('  for the format — or point MASTER_KEYWORDS_FILE at your own list.\n');
    } else {
      const keywords = JSON.parse(fs.readFileSync(file, 'utf-8'));
      console.log(`Master keywords: ${keywords.length} terms to load...`);

      // Batch in groups of 50 (Supabase upsert limit)
      for (let i = 0; i < keywords.length; i += 50) {
        const batch = keywords.slice(i, i + 50);
        const result = await postBatch('/api/keywords/master', batch);
        console.log(`  Batch ${Math.floor(i / 50) + 1}: ${result.added} upserted`);
      }
      console.log('  Done.\n');
    }
  }

  if (seedNegatives) {
    const file = process.env.GENERAL_NEGATIVES_FILE
      ? path.resolve(process.env.GENERAL_NEGATIVES_FILE)
      : path.join(__dirname, 'seed-general-negatives.json');
    const keywords = JSON.parse(fs.readFileSync(file, 'utf-8'));
    console.log(`General negatives: ${keywords.length} terms to load...`);

    // Smaller batches to avoid ON CONFLICT collisions after normalize()
    for (let i = 0; i < keywords.length; i += 20) {
      const batch = keywords.slice(i, i + 20);
      const result = await postBatch('/api/keywords/negatives', batch);
      console.log(`  Batch ${Math.floor(i / 20) + 1}: ${result.added} upserted`);
    }
    console.log('  Done.\n');
  }

  // Show final counts
  const statsRes = await fetch(`${API_BASE}/api/keywords/stats`, {
    headers: { 'X-API-Key': API_KEY },
  });
  const stats = await statsRes.json();
  console.log('Final counts:');
  console.log(`  Master keywords:   ${stats.master_keywords}`);
  console.log(`  Vendor keywords:   ${stats.vendor_keywords}`);
  console.log(`  General negatives: ${stats.general_negatives}`);
}

main().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
