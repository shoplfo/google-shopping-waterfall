# Shopping Waterfall Engine

Self-hosted automation for the **Google Shopping priority waterfall** — a campaign structure that sorts your shopping traffic by search intent so you can bid differently on "sofa" and "ashley 4390385 sectional in grey".

It creates the campaigns, keeps the negative keyword lists in sync, and runs hourly to catch anything that slipped through.

> ### ⚠️ Read this first
>
> **This is working software, not polished software.** It was built for one agency's
> real accounts and then generalized for release. Expect to hit bugs, and expect to
> fix some yourself.
>
> - It **spends real money** and **modifies real Google Ads accounts**. Test on a
>   throwaway or low-budget account first.
> - Campaigns are created **PAUSED**. Nothing spends until you enable them by hand.
> - There is **no test suite**. Verify behavior against the Google Ads UI.
> - Google changes their API. Something here will eventually break.
> - It has been run in production against a handful of accounts — not hundreds.
>   Scale limits are unknown.
>
> **Use at your own risk.** MIT licensed: no warranty, no support guarantee.
> Bug reports and pull requests are welcome.

---

## Table of contents

- [What problem this solves](#what-problem-this-solves)
- [How the waterfall works](#how-the-waterfall-works)
- [How the app works](#how-the-app-works)
- [What you need before you start](#what-you-need-before-you-start)
- [Setup](#setup)
- [Using it day to day](#using-it-day-to-day)
- [Cost to run](#cost-to-run)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Contributing](#contributing)

---

## What problem this solves

Google Shopping campaigns **do not let you target keywords**. You upload a product feed, and Google decides which searches show your ads. Your only lever is *negative* keywords — telling Google what **not** to match.

That creates a real problem: one campaign gets everything from `"furniture"` (broad, cheap, low intent) to `"ashley 4390385 sectional grey left-facing"` (specific, high intent, ready to buy). Same bid for both. You either overpay for browsers or underbid on buyers.

The **priority waterfall** solves it: run the same products in three campaigns at different Google priorities, and use negative keywords to push each type of search into the right one.

The hard part is maintaining it. Every new search term Google finds needs a decision: does it belong here, or should it be negated down the ladder? Do that by hand across several accounts and thousands of terms and you're doing data entry forever. **This app does that part.**

---

## How the waterfall works

Google always tries the **highest-priority** campaign first. If that campaign's negatives block the search, it falls to the next. So high priority + heavy negatives = a filter, not a destination.

Three campaigns per vendor, sharing one budget and the same products:

| Campaign | Google priority | Blocks | What lands here | Bid |
|---|---|---|---|---|
| **General** | High | *nothing* | Broad, generic searches — `"sofa"`, `"dining table"` | Lowest (~$0.05) |
| **Brand** | Medium | product terms | Brand searches — `"ashley furniture"` | Medium (~$0.10) |
| **Product** | Low | brand terms | Specific product searches — `"ashley 4390385 sectional"` | Highest (~$0.25) |

Reading the flow for `"ashley 4390385 sectional"`:

1. **General** (high priority) is tried first. Nothing blocks it... but General also catches every generic search, so it's bid low.
2. To stop that, General carries your **master negatives** — your product-category terms. `"sectional"` is a master keyword, so General is blocked.
3. Falls to **Brand** (medium). Brand blocks *product* terms. `"4390385"` is a product keyword → blocked.
4. Falls to **Product** (low priority, highest bid). Nothing blocks it. It wins.

Meanwhile a plain `"sofa"` search gets blocked nowhere except at Product and Brand (which block generic master terms), so it settles in **General** at the low bid. Exactly what you want.

**Three keyword lists drive this:**

| List | Scope | Example | Purpose |
|---|---|---|---|
| **Master keywords** | Global (all accounts) | `sofa`, `dining table`, `sectional` | Your product categories. Pushes generic traffic down. |
| **Vendor keywords** | Per manufacturer/brand | `ashley furniture`, `4390385` | Split into `brand` and `product` types. Routes between tiers. |
| **General negatives** | Global | `used`, `jobs`, `rental`, `diy` | Junk you never want, at any tier. |

---

## How the app works

### The two halves

**1. Bulk sync (fast, catches ~95%)** — you click **Sync**. The app pushes your whole keyword list into Google Ads at once:

- **General negatives** → one *SharedSet* per client, attached to every campaign. (A SharedSet is Google's shared negative list — one list, many campaigns.)
- **Brand + Product keywords** → written **directly onto the campaign** as negatives (up to 10,000 per campaign).

**2. Hourly cron (the safety net, catches the rest)** — every hour the engine:

1. Pulls the **search terms report** from Google Ads (what people actually typed).
2. For each term, checks it against your keyword lists.
3. Any term that shouldn't be in the campaign it landed in gets added as an **exact-match negative** on that ad group.
4. Logs everything to the dashboard.

Bulk sync handles known terms. The cron handles the long tail of weird searches nobody predicted.

### What it creates in your Google Ads account

Per vendor: **1 shared budget + 3 campaigns + 3 ad groups**, named:

```
{PREFIX} | {Vendor} | Shopping | General
{PREFIX} | {Vendor} | Shopping | Brand
{PREFIX} | {Vendor} | Shopping | Product
```

`{PREFIX}` is yours — set it in **Settings → Campaign Name Prefix** (default `ADS`).

Plus one negative-keyword SharedSet per client:
```
{PREFIX} | {Client} | Master Negatives
```

And optionally an account-wide block on mobile-app placements.

### Multi-account by design

"Client" = one Google Ads account. Each connects via its own OAuth consent. Manage many from one dashboard, or just use it for your own single account. Role-based access (`client` < `agency` < `account_manager` < `admin`) lets you give people scoped logins.

---

## What you need before you start

You'll need accounts on three services. **The app itself is free; the services have a free tier that's enough to start.**

| Service | What for | Cost | Alternatives |
|---|---|---|---|
| **[Supabase](https://supabase.com)** | Postgres database | Free tier is plenty | Any Postgres — Neon, Railway PG, self-hosted. Needs code changes: the app uses the Supabase JS client, not raw SQL. |
| **[Railway](https://railway.app)** | Hosting web + cron | ~$5/mo | Render, Fly.io, a VPS, or your own machine. Any Node host with a scheduler. |
| **Google Ads API access** | Reading/writing campaigns | Free | None — required. |

### Google Ads API access is the slow part

You need a **developer token**, and getting one takes real time:

1. You need a **Google Ads Manager (MCC) account** — free to create at [ads.google.com/home/tools/manager-accounts](https://ads.google.com/home/tools/manager-accounts/).
2. In the MCC: **Tools & Settings → Setup → API Center** → apply for a developer token.
3. You start with a **test-account-only** token. Applying for **Basic access** (needed for real accounts) is a form plus a review — **usually a few days, sometimes a couple of weeks**.
4. Separately, in [Google Cloud Console](https://console.cloud.google.com): create an **OAuth 2.0 Client ID** (type: *Web application*) and add your callback URL as an authorized redirect URI.

**Start this first** — everything else takes an afternoon; this is the bottleneck.

You also need a **Google Merchant Center** account with an active product feed. Shopping campaigns can't exist without one.

---

## Setup

### 1. Database

Create a Supabase project, then in the **SQL Editor** run, in order:

```
sql/schema.sql
sql/migration-v2.sql
sql/migration-v3.sql
...
sql/migration-v18.sql
```

Run them **in numeric order** — they build on each other. Copy each file's contents into the SQL Editor and execute.

### 2. Environment

```bash
git clone https://github.com/shoplfo/google-shopping-waterfall.git
cd shopping-waterfall-engine
npm install
cp .env.example .env
```

Fill in `.env`. Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Run it

```bash
npm run dev
```

Open <http://localhost:3000>. Create your first admin user when prompted.

### 4. Seed your keyword lists

The universal negatives (`used`, `jobs`, `rental`, `wholesale`, …) ship with the repo:

```bash
API_KEY=your-api-secret-key npm run seed -- --negatives
```

**Master keywords are not included** — they depend entirely on what you sell. Two example files show the format:

- `sql/seed-master-keywords.furniture-example.json` — ~200 furniture category terms
- `sql/seed-general-negatives.furniture-example.json` — 23 furniture-specific negatives

Create your own `sql/seed-master-keywords.json`:

```json
[
  {"keyword":"running shoes","category":"footwear"},
  {"keyword":"trail runners","category":"footwear"}
]
```

Then:

```bash
API_KEY=your-api-secret-key npm run seed -- --master
```

Or manage them in the dashboard's **Master Keywords** tab. (That file is gitignored — your keyword list is usually proprietary.)

### 5. Connect a Google Ads account

1. **Clients** tab → **Add Client**. Enter a name, the Google Ads customer ID, and the Merchant Center ID.
2. Click **Connect Google Ads** → complete the OAuth consent.
3. **Vendors** tab → add your manufacturers/brands, and their keywords (`brand` vs `product`).
4. Client detail → assign vendors → **API** to create their campaigns.
5. Click **Sync** to push the negative lists.
6. **Check the campaigns in Google Ads.** Then unpause when you're satisfied.

### 6. Deploy

Push to GitHub, connect the repo in Railway, add the same env vars, and add a **Cron service** on the same repo:

- Schedule: `0 * * * *` (hourly)
- Command: `npm run cron`

Set `OAUTH_CALLBACK_URL` to your production URL **and** add that URL to your Google Cloud OAuth client's authorized redirect URIs — they must match exactly.

---

## Using it day to day

| Action | Where | What happens |
|---|---|---|
| **Sync** | Clients row, or vendor row | Pushes current keyword lists to Google Ads. Idempotent — safe to click repeatedly. |
| **Rebuild** | Clients row | Force-creates a fresh Master Negatives SharedSet. Use if you deleted it in the Ads UI. |
| **Sync All Clients** | General Negatives tab | Same as Sync, looped over every active client. |
| **Run** | Clients row | Runs the hourly engine now instead of waiting. |
| **Run Logs** | Nav | What the cron did, per run, per client. |

**Sync status dots** (green <1h, orange <24h, red older) show when each client/vendor last synced.

### After you change keywords

Adding or removing keywords **does not** push to Google automatically — click **Sync**. This is deliberate: keyword edits are frequent and you rarely want each keystroke hitting the Ads API.

---

## Cost to run

| Item | Typical |
|---|---|
| Supabase | $0 (free tier) |
| Railway (web + cron) | ~$5/mo |
| Google Ads API | $0 |
| **Total** | **~$5/mo** plus your ad spend |

Run it on your own machine or a spare VPS and it's free.

---

## Configuration reference

**Settings tab** (admin only):

| Setting | Default | What it does |
|---|---|---|
| Campaign Name Prefix | `ADS` | First segment of every campaign name. Change before creating campaigns. |
| Merchant Center Feed Label | `US` | Feed label on new Shopping campaigns. Blank = account default. |
| Default Date Range | `TODAY` | Search-term lookback per engine run. |
| Default Impression Threshold | `0` | Ignore search terms below this many impressions. |
| Default MCC Account ID | — | Manager account for API access. |
| Hourly Cron | on | Master switch for automated runs. |
| Block Mobile Apps | on | Account-wide negative on mobile app placements (category `69500`). |

**Bid defaults** are in `TIER_CONFIG` at the top of `src/engine/campaignManager.js`:

```js
{ tier: 1, name: 'General', priority: 2, cpcMicros: 50000  },  // $0.05
{ tier: 2, name: 'Brand',   priority: 1, cpcMicros: 100000 },  // $0.10
{ tier: 3, name: 'Product', priority: 0, cpcMicros: 250000 },  // $0.25
```

`cpcMicros` is millionths of a currency unit — `50000` = $0.05. Edit and redeploy to change defaults for newly created campaigns.

---

## Troubleshooting

**"I don't see my campaigns in Google Ads"**
They're created **PAUSED**. Clear the "Enabled" / "Has spend" filters.

**Sync says success but Google Ads is empty**
Check **Run Logs**. Sync results include an `errors` count and detail string — the dashboard shows it in red. A partial failure reports which chunk failed and why.

**`OPERATION_NOT_PERMITTED_FOR_CONTEXT`**
Something isn't supported on Shopping campaigns. Demographic and household-income targeting, for example, are not — that feature was attempted and removed.

**Empty error messages / `undefined`**
The `google-ads-api` library often leaves `.message` blank; the detail is in `err.errors[]`. Use `formatGoogleAdsError()` in `src/engine/googleAds.js` — don't log raw `err.message`.

**`AUTHENTICATION_ERROR` / `USER_PERMISSION_DENIED`**
Usually the MCC path. The app tries the manager account first and falls back to direct access. Check the client's **MCC Account ID** and that the OAuth user actually has access.

**Deleted a negative list in the Google Ads UI**
Just click **Sync** — it self-heals and recreates it. **Rebuild** forces it immediately.

**OAuth redirect mismatch**
`OAUTH_CALLBACK_URL` must byte-for-byte match an authorized redirect URI on your Google Cloud OAuth client. Trailing slashes count.

**Everyone got logged out after a deploy**
Sessions are in-memory. Restart = logout. Swap in `connect-pg-simple` (already a dependency) if that bothers you.

---

## Project layout

```
src/
  index.js              Express app, sessions, RBAC middleware
  config.js             Environment wiring
  naming.js             Campaign/SharedSet naming (configurable prefix)
  db.js                 Supabase clients
  cron.js               Cron entry point
  permissions.js        Role hierarchy
  engine/
    dispatcher.js       Loops active clients
    processor.js        Per-client waterfall logic
    matcher.js          Keyword matching
    googleAds.js        Google Ads API wrapper
    campaignManager.js  Campaign creation
    csvExporter.js      Google Ads Editor CSV export
  routes/               REST API (clients, vendors, keywords, engine, logs, users, settings)
dashboard/
  index.html            The whole dashboard, one file, no framework
sql/
  schema.sql            Base schema — run first
  migration-v2..v18.sql Run in order after schema.sql
  seed.js               Keyword seeding script
```

The dashboard is deliberately one dependency-free HTML file. It's not pretty, but you can read it top to bottom and change it without a build step.

---

## Contributing

Issues and PRs welcome. This was extracted from a working system, so there are rough edges — if you hit one, a bug report with the error detail from Run Logs is genuinely useful.

If you add a database column, add a new numbered `sql/migration-vN.sql`. Never edit an existing migration — other people have already run it.

## License

MIT — see [LICENSE](LICENSE). No warranty. You are responsible for what it does to your ad accounts.
