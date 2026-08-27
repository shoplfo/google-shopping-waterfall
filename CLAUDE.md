# CLAUDE.md

Onboarding doc for Claude Code sessions working on this repo.

## What this is

Shopping Waterfall Engine — automates negative-keyword management for Google Shopping campaigns. Three-tier priority waterfall (General / Brand / Product), hourly cron, per-client Google Ads accounts.

See `README.md` for the user-facing explanation of the waterfall strategy and setup.

- **License:** MIT (open source)
- **Deploy target:** any Node host; Railway config included (`railway.toml`)

## Stack

- Node.js 18+ / Express
- Supabase (Postgres) — service role from backend, session auth for dashboard
- `google-ads-api` npm v23 (wraps Google Ads API v23, current as of 2026)
- Any Node host for the web server + an hourly `npm run cron`
- Vanilla HTML/JS dashboard at `dashboard/index.html` (no framework)

## Commands

```bash
npm install
npm run dev        # local dev on port 3000 with nodemon
npm start          # production start
npm run cron       # one-shot engine run (schedule this hourly)
```

## Project layout

```
src/
  index.js            # Express app, session + RBAC middleware
  config.js           # env var wiring
  db.js               # Supabase clients (service + anon)
  cron.js             # Cron entry point
  permissions.js      # RBAC role hierarchy + scope resolver
  engine/
    dispatcher.js     # Loops active clients
    processor.js      # Per-client waterfall logic (the brain)
    matcher.js        # Keyword matching
    googleAds.js      # Google Ads API wrapper + formatGoogleAdsError
    campaignManager.js# Campaign creation + post-create optimizations
    csvExporter.js    # Google Ads Editor CSV export
  routes/
    auth.js           # login/logout/forgot-password
    oauth.js          # Google Ads OAuth consent
    clients.js        # Client CRUD + campaign creation + optimizations
    vendors.js        # Global vendor registry
    keywords.js       # Master + vendor + general negatives
    engine.js         # Manual run triggers
    logs.js           # Run logs + stats
    users.js          # Admin user management
    settings.js       # Global app_settings (singleton)
dashboard/
  index.html          # Full dashboard (single file)
  login.html          # Login page
  reset-password.html # Password reset
sql/
  schema.sql          # Base schema
  migration-v2.sql … v18.sql  # Forward-only migrations (run in order)
  seed.js             # Seeds keyword lists (master list is user-supplied)
```

## Environment

See `.env.example` for the full list with comments. Key ones:
- `API_SECRET_KEY`, `SESSION_SECRET`
- `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `SUPABASE_ANON_KEY`
- `GOOGLE_ADS_DEVELOPER_TOKEN` / `GOOGLE_ADS_CLIENT_ID` / `GOOGLE_ADS_CLIENT_SECRET`
- `OAUTH_CALLBACK_URL=https://your-domain.com/api/oauth/google/callback`

## Key concepts

### Waterfall tiers
Shopping campaigns can't target keywords directly — you shape traffic by who *blocks* which keyword sets:

| Tier | Priority | Blocks | Catches |
|---|---|---|---|
| General | HIGH (2) | nothing | leftover / unmatched queries |
| Brand | MEDIUM (1) | master + product keywords | vendor brand searches |
| Product | LOW (0) | master + brand keywords | specific product searches |

Campaign names: `{PREFIX} | {Vendor} | Shopping | {General|Brand|Product}`, where `{PREFIX}` comes from
`app_settings.campaign_name_prefix` (migration v18, default `ADS`). All name construction goes through
`src/naming.js` — never hardcode a prefix.

### Keyword types
- **Master keywords** — your product-category terms, shared across all clients (industry-specific; no default list ships in the repo)
- **Vendor keywords** — global `vendors` + `vendor_keywords` tables, assigned to clients via `client_vendors` junction. `campaign_type` = 'brand' or 'product'.
- **General negatives** — universal blocklist (used, jobs, diy, free). Applied via SharedSet per client (see below).

### Waterfall negatives (migrations v12, v14, v16, v17)
Each client's Google Ads account holds:
- **One Master Negatives SharedSet** (general_negatives, client-wide)
- **Direct CampaignCriterion negatives** on each vendor's campaigns for brand / product keywords (no SharedSet — v17 moved these off shared_criterion onto campaign_criterion because each list was only attached to one campaign anyway, and campaign-level supports 10K negatives / 5000-op batch vs. SharedSet's 5K cap / 1000-op chunk).

The **hourly cron still runs** as the safety net for anything the SharedSet + CampaignCriterion writes don't catch.

| Layer | Stored in Google Ads as | Populated from | Match type | Attached to | Resource name persisted on |
|---|---|---|---|---|---|
| Master Negatives | `SharedSet` (NEGATIVE_KEYWORDS) named `{PREFIX} | {Client} | Master Negatives`\| {Client} \| Master Negatives` | `general_negatives` | per-row (`general_negatives.match_type`, default `phrase`) | every tracked campaign on the client | `clients.master_shared_set_resource_name` |
| Brand Keywords | `CampaignCriterion` (negative=TRUE, KEYWORD) directly on the campaign | `vendor_keywords` where `campaign_type='brand' AND vendor_id=?` | `broad` | that vendor's campaign where `blocks_brand=TRUE` (Product tier) | — (no persistence needed; diff-synced from DB) |
| Product Keywords | `CampaignCriterion` (negative=TRUE, KEYWORD) directly on the campaign | `vendor_keywords` where `campaign_type='product' AND vendor_id=?` | `broad` | that vendor's campaign where `blocks_product=TRUE` (Brand tier) | — (no persistence needed; diff-synced from DB) |

SharedSet count per client is just **1** (the Master) — well under Google's 20-sets-per-customer cap regardless of vendor count.

**Household-income exclusion was attempted and removed** (migration v13) — Google Ads does not support it on Shopping campaigns at any level. Don't re-add unless a non-Shopping channel is introduced.

### Sync helpers (`src/engine/googleAds.js`)
- `syncMasterNegativesForClient(customer, customerId, client, generalNegatives, allCampaignIds)` — Master SharedSet. Self-heals: if the SharedSet was deleted in the Google Ads UI, catches tagged `SHARED_SET_NOT_FOUND` and retries once with a fresh SharedSet.
- `rebuildMasterSharedSet(customer, customerId, client, generalNegatives, allCampaignIds)` — force-create a new Master SharedSet (ignores cached resource name). Used by the Rebuild button.
- `syncVendorNegatives(customer, customerId, vendorName, brandKeywords, productKeywords, vendorConfigs)` — diff-syncs brand + product keyword lists onto the matching vendor campaigns as `campaign_criterion` negatives. Returns `{brand, product}`.
- `syncCampaignNegativeKeywords(customer, campaignResourceName, desired, defaultMatchType='BROAD')` — reconciles one campaign's negative keywords. Batch size **5000** (Google's standard `campaign_criterion` mutate limit). Per-chunk try/catch.
- Master SharedSet helpers: `ensureMasterSharedSet`, `syncMasterSharedSetCriteria` (chunked 1000 ops, per-chunk try/catch per `af7854c`), `attachSharedSetToCampaigns` — all idempotent.

### Sync trigger points
1. **`createVendorCampaigns` in `src/engine/campaignManager.js`** — runs master + this vendor's brand/product sync right after campaign creation
2. **`POST /api/clients/:id/sync-master-negatives`** (client-wide) — master + loops all vendors
3. **`POST /api/clients/:id/vendors/:vendorId/sync-master-negatives`** (vendor-scoped) — master + that vendor only
4. **`POST /api/clients/:id/rebuild-master-negatives`** (new in v17) — force-rebuild Master SharedSet; dashboard "Rebuild" button calls this
5. **`POST /api/keywords/negatives/sync-all`** — loops active clients, each doing master + all their vendors

Timestamps: `clients.master_negatives_synced_at` (client-wide last sync) and `client_vendors.master_negatives_synced_at` (per-vendor last sync). Dashboard shows colored dots based on these.

### Mobile-app block
Account-wide `CustomerNegativeCriterion` with `mobile_app_category` = `mobileAppCategoryConstants/69500` (catch-all apps). Covers Shopping + PMax in one call. On by default. Per-client flag: `clients.block_mobile_apps`.

### RBAC
Four roles (`client` < `agency` < `account_manager` < `admin`) defined in `src/permissions.js`. `requireRole`, `requirePermission`, `attachClientScope` middleware in `src/middleware/auth.js`. API-key requests bypass role checks.

## Gotchas

- **`google-ads-api` errors have empty `.message`.** Use `formatGoogleAdsError()` from `src/engine/googleAds.js` — it flattens `err.errors[]` with codes, field paths, and triggers. Don't log raw `err.message`.
- **MCC fallback:** `createAdsClient(refresh, customerId, mccId)` tries MCC login-customer first; the code probes with a trivial GAQL query and re-creates the client without `mccId` if it fails. This is already wired in `campaignManager.js` and `processor.js`.
- **Google Ads v23 enum strings vs ints:** We pass string enum names (e.g., `'INCOME_RANGE_0_50'`) to the library and it handles conversion. Don't switch to numeric enum values without testing.
- **Income/demographic targeting is NOT supported on Shopping.** Google rejects `income_range` criteria with `OPERATION_NOT_PERMITTED_FOR_CONTEXT`, trigger=SHOPPING. Feature removed in migration v13. Don't re-add.
- **Campaigns are created `status: PAUSED`.** They won't show up in Google Ads views filtered to "enabled" or "with spend". User-caused confusion in the past.
- **Session store is in-memory.** Restarting the server kicks everyone out. Acceptable today; migrate to `connect-pg-simple` if it becomes an issue.
- **There is no staging environment and no test suite.** Verify changes against the Google Ads UI on a low-budget or test account before trusting them.
- **Migrations are forward-only, numbered files.** Don't edit old ones. Add `migration-vN+1.sql`. The user runs them by hand in the Supabase SQL Editor and confirms before I push code that depends on new columns.

## When making changes

1. **Don't create commits unless asked.** User says "push" when ready.
2. **For DB-schema changes:** write the migration, show the SQL to the user, wait for confirmation it ran, THEN push the code that depends on it.
3. **Prefer `Write` over many small `Edit`s** when deleting a feature across many files — dramatically faster.
4. **Parse-check before pushing:** `node -e "require('./src/routes/X.js'); ..."` catches silly syntax breakage fast.
5. **Commit style:** imperative subject line, short body explaining *why*, and the `Co-Authored-By` footer (see `git log` for examples).

## Memory files

Maintainers may keep local notes outside the repo. Nothing here should depend on them.

Update this file when shipping significant changes.

## Current feature surface (as of April 18, 2026)

- RBAC-gated dashboard with Clients / Vendors / Master KW / Vendor KW / General Negatives / Run Logs / Settings tabs
- OAuth consent flow for per-client Google Ads access
- Manual "Run Engine" triggers (all clients or single) + hourly cron
- Campaign creation per vendor (shared budget + 3 tier campaigns)
- **Waterfall negatives**: client-wide Master Negatives SharedSet + per-vendor Brand + per-vendor Product as direct campaign-level negatives on the appropriate tier campaigns (v17). Broad match on vendor keywords.
- **Rebuild button** on Clients list — force-creates a fresh Master SharedSet when the old one was deleted in the Google Ads UI (v17).
- Sync status visible per-client on the Clients list and per-vendor on the Client Detail vendor table (colored dot + timestamp)
- One-click "Sync" buttons: per-vendor row, per-client row, and "Sync All Clients" on the General Negatives tab
- Account-wide mobile-app block via `CustomerNegativeCriterion` (category `69500`, on by default)
- URL tracking audit (finds stale UTM/tracking templates)
- Observation audiences (in-market) at ad-group level
- Google Ads Editor CSV export per client
- Password reset via Supabase `password_reset_tokens`
- Per-client `income_exclusion` — **REMOVED in v13** (not supported on Shopping by Google)
