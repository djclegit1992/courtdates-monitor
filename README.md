# Court Dates Monitor

Monitors the Toronto Superior Court of Justice Calendly booking pages (calendly.com/toronto-region), shows the first open date for every hearing type, and emails subscribers when earlier or new dates open.

## How it works

Every 30 minutes, a GitHub Actions workflow runs `poller/poll.js`, which:

1. Auto-discovers all event types under the `toronto-region` profile (no hardcoding the 14 sub-links).
2. Scans each one month-by-month, 10 months ahead, collecting every available date.
3. Writes `data/snapshot.json` and diffs it against the previous run. An "earlier first date" or "new dates added" produces entries in `data/changes.json`.
4. `poller/notify.js` reads the changes, pulls subscribers from Supabase, and sends digest emails via Resend.
5. The workflow commits `data/` back to the repo, which doubles as a free historical record of booking availability over time.

The WordPress embed (`wordpress/courtdates-monitor-embed.html`) reads the committed snapshot from raw.githubusercontent.com and renders the dashboard plus the subscribe form. It never touches Calendly directly and never sees any secret keys.

## Setup (about 30 minutes)

### 1. Local smoke test first

Before anything else, verify the Calendly endpoints respond from your machine:

```
LIMIT_TYPES=1 HORIZON_MONTHS=2 node poller/poll.js
```

You should see one event type discovered and scanned. If discovery fails (Calendly occasionally changes the profile endpoint shape), create `poller/event-types.json` with entries copied from the 14 sub-links:

```json
[
  { "name": "Civil Motion (Short)", "slug": "civil-motion-short" }
]
```

The slug is the last path segment of each booking sub-link. UUIDs are resolved automatically.

### 2. GitHub

1. Create a repo (public is fine; the data is public availability anyway) and push these files.
2. Actions tab: enable workflows. The `monitor.yml` cron starts automatically; you can also trigger it manually via "Run workflow".
3. Settings > Secrets and variables > Actions: add `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `RESEND_API_KEY`, `FROM_EMAIL`, `DASHBOARD_URL`.

Until the secrets exist, the poller still runs and the dashboard still works; notify.js just skips sending and says so in the log.

### 3. Supabase

1. Run `supabase/schema.sql` in the SQL editor.
2. Note the project URL and the publishable (anon) key for the WordPress embed, and the service role key for the GitHub secret. The service role key goes in GitHub only, never in WordPress.

### 4. Resend

1. Verify your sending domain (courtready.ca or courtdates.ca) in Resend: add their DKIM/SPF DNS records.
2. Create an API key, add it as the `RESEND_API_KEY` secret.
3. Set `FROM_EMAIL` to something like `Courtready Alerts <alerts@courtready.ca>`.

### 5. WordPress

1. Open `wordpress/courtdates-monitor-embed.html`, fill in the three CONFIG values at the top of the script (snapshot raw URL, Supabase URL, Supabase publishable key).
2. Paste the whole file into a Custom HTML block.

The embed follows the standard conventions: `all: initial` isolation, `!important` on every property, IIFE, ES5 only, no AND-AND or OR-OR operators.

## Tuning

| Env var | Default | Meaning |
|---|---|---|
| `PROFILE_SLUG` | `toronto-region` | Calendly profile to monitor |
| `HORIZON_MONTHS` | `10` | How far ahead to scan |
| `REQUEST_DELAY_MS` | `400` | Politeness delay between Calendly requests |
| `LIMIT_TYPES` | `0` (all) | Cap event types, for quick tests |

At 14 types x 10 months x ~400ms, a full run takes roughly 2 minutes, well inside free Actions limits at 48 runs/day.

## Testing without touching Calendly

`node poller/test-offline.js run1` seeds a baseline against a mocked API; `run2` simulates an earlier date opening and verifies the diff. Delete `data/*.json*` afterward so production starts clean.

## Known limitations and V2 ideas

- First production run is baseline-only by design (no notification storm on day one).
- Duplicate subscriptions return a friendly "already subscribed" message; changing selections requires unsubscribe-then-resubscribe. A preferences-update RPC is an easy V2.
- Double opt-in confirmation emails would strengthen the CASL posture; the current express-consent checkbox with recorded timestamp and one-click unsubscribe is the V1 baseline.
- If GitHub's datacenter IPs ever get bot-blocked by Calendly, run the identical scripts on any small VPS with cron; nothing else changes.
- `data/history.jsonl` accumulates one line per run with each hearing type's first available date: raw material for a "how far ahead must Torontonians book a hearing" analysis.
