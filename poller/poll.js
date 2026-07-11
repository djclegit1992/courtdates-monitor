/**
 * poll.js - Calendly availability poller for Toronto SCJ booking pages
 *
 * Discovers all event types under a Calendly profile, scans each one
 * month-by-month for available dates, writes data/snapshot.json, and
 * diffs against the previous snapshot to produce data/changes.json.
 *
 * Zero dependencies. Requires Node 18+ (built-in fetch).
 *
 * Usage:
 *   node poller/poll.js
 *
 * Env overrides:
 *   PROFILE_SLUG     default "toronto-region"
 *   TIMEZONE         default "America/Toronto"
 *   HORIZON_MONTHS   default 10  (how far ahead to scan)
 *   REQUEST_DELAY_MS default 400 (politeness delay between requests)
 *   LIMIT_TYPES      default 0   (0 = all; set 1-2 for quick local tests)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = {
  profileSlug: process.env.PROFILE_SLUG || 'toronto-region',
  timezone: process.env.TIMEZONE || 'America/Toronto',
  horizonMonths: parseInt(process.env.HORIZON_MONTHS || '10', 10),
  requestDelayMs: parseInt(process.env.REQUEST_DELAY_MS || '400', 10),
  limitTypes: parseInt(process.env.LIMIT_TYPES || '0', 10),
  dataDir: path.join(__dirname, '..', 'data'),
  userAgent:
    'CourtdatesMonitor/1.0 (+https://courtdates.ca; availability monitor commissioned for court booking pages)',
};

const SNAPSHOT_PATH = path.join(CONFIG.dataDir, 'snapshot.json');
const CHANGES_PATH = path.join(CONFIG.dataDir, 'changes.json');
const HISTORY_PATH = path.join(CONFIG.dataDir, 'history.jsonl');
const FALLBACK_TYPES_PATH = path.join(__dirname, 'event-types.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, attempt) {
  attempt = attempt || 1;
  const res = await fetch(url, {
    headers: {
      'User-Agent': CONFIG.userAgent,
      Accept: 'application/json',
    },
  });

  if (res.status === 429 && attempt <= 2) {
    console.warn('  429 rate limited, backing off 6s...');
    await sleep(6000);
    return fetchJson(url, attempt + 1);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      'HTTP ' + res.status + ' for ' + url + ' :: ' + text.slice(0, 200)
    );
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      'Non-JSON response (bot protection?) for ' + url + ' :: ' + text.slice(0, 200)
    );
  }
}

/**
 * Discover event types under the profile. Calendly's booking frontend uses
 * an unauthenticated endpoint for this; the response shape has shifted over
 * time, so we accept several shapes. If discovery fails entirely, we fall
 * back to poller/event-types.json (an array of {name, slug} objects) and
 * resolve UUIDs via the lookup endpoint.
 */
async function getEventTypes() {
  const url =
    'https://calendly.com/api/booking/profiles/' +
    CONFIG.profileSlug +
    '/event_types';
  let raw = null;
  try {
    const json = await fetchJson(url);
    if (Array.isArray(json)) raw = json;
    else if (Array.isArray(json.collection)) raw = json.collection;
    else if (Array.isArray(json.event_types)) raw = json.event_types;
    else if (Array.isArray(json.events)) raw = json.events;
  } catch (e) {
    console.warn('Profile discovery failed: ' + e.message);
  }

  let types = [];
  if (raw) {
    types = raw
      .filter((t) => !t.hidden)
      .map((t) => ({
        name: t.name,
        slug: t.slug,
        uuid: t.uuid || t.id || null,
        duration: t.duration || null,
      }));
  }

  if (types.length === 0 && fs.existsSync(FALLBACK_TYPES_PATH)) {
    console.warn('Using fallback event-types.json');
    types = JSON.parse(fs.readFileSync(FALLBACK_TYPES_PATH, 'utf8'));
  }

  if (types.length === 0) {
    throw new Error(
      'No event types discovered. Create poller/event-types.json with [{"name": "...", "slug": "..."}] entries copied from the 14 sub-links.'
    );
  }

  // Resolve missing UUIDs via the lookup endpoint
  for (const t of types) {
    if (!t.uuid) {
      await sleep(CONFIG.requestDelayMs);
      const lookupUrl =
        'https://calendly.com/api/booking/event_types/lookup?event_type_slug=' +
        encodeURIComponent(t.slug) +
        '&profile_slug=' +
        encodeURIComponent(CONFIG.profileSlug);
      try {
        const info = await fetchJson(lookupUrl);
        t.uuid = info.uuid || (info.event_type ? info.event_type.uuid : null);
        if (!t.name) t.name = info.name || t.slug;
      } catch (e) {
        console.warn('  Lookup failed for ' + t.slug + ': ' + e.message);
      }
    }
  }

  return types.filter((t) => t.uuid);
}

/** Today's date string (YYYY-MM-DD) in the court's timezone. */
function todayInTz() {
  return new Date().toLocaleDateString('en-CA', { timeZone: CONFIG.timezone });
}

/** Build [rangeStart, rangeEnd] month chunks from today forward. */
function buildMonthChunks(horizonMonths) {
  const chunks = [];
  const todayStr = todayInTz();
  const parts = todayStr.split('-').map(Number);
  let y = parts[0];
  let m = parts[1]; // 1-12

  for (let i = 0; i < horizonMonths; i++) {
    const start =
      i === 0
        ? todayStr
        : y + '-' + String(m).padStart(2, '0') + '-01';
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = y + '-' + String(m).padStart(2, '0') + '-' + String(lastDay).padStart(2, '0');
    chunks.push([start, end]);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return chunks;
}

/** Scan one event type across the horizon; return sorted available dates. */
async function scanEventType(eventType, chunks) {
  const available = [];
  for (const [rangeStart, rangeEnd] of chunks) {
    await sleep(CONFIG.requestDelayMs);
    const url =
      'https://calendly.com/api/booking/event_types/' +
      eventType.uuid +
      '/calendar/range?timezone=' +
      encodeURIComponent(CONFIG.timezone) +
      '&diagnostics=false&range_start=' +
      rangeStart +
      '&range_end=' +
      rangeEnd;

    const json = await fetchJson(url);
    const days = Array.isArray(json.days) ? json.days : [];
    for (const day of days) {
      let isAvailable = day.status === 'available';
      if (!isAvailable) {
        // Defensive fallback for shape drift
        if (day.enabled === true && Array.isArray(day.spots) && day.spots.length > 0) {
          isAvailable = true;
        }
      }
      if (isAvailable) available.push(day.date);
    }
  }
  available.sort();
  return available;
}

function loadPreviousSnapshot() {
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch (e) {
    console.warn('Could not parse previous snapshot: ' + e.message);
    return null;
  }
}

function diffSnapshots(prev, next) {
  const changes = [];
  const prevBySlug = {};
  if (prev) {
    for (const t of prev.event_types) prevBySlug[t.slug] = t;
  }

  for (const t of next.event_types) {
    if (t.error) continue;
    const old = prevBySlug[t.slug];
    const oldDates = old && Array.isArray(old.available_dates) ? old.available_dates : [];
    const oldSet = new Set(oldDates);
    const addedDates = t.available_dates.filter((d) => !oldSet.has(d));

    const oldFirst = old ? old.first_available : null;
    const improved =
      t.first_available !== null &&
      (oldFirst === null || t.first_available < oldFirst);

    // Carry forward / update the "last improved" timestamp for the dashboard badge
    if (improved) {
      t.last_improved_at = next.generated_at;
    } else if (old && old.last_improved_at) {
      t.last_improved_at = old.last_improved_at;
    }

    // Only meaningful changes trigger notifications. First run (no prev
    // snapshot) is baseline-setting, not news.
    if (prev && (improved || addedDates.length > 0)) {
      changes.push({
        slug: t.slug,
        name: t.name,
        booking_url: t.booking_url,
        old_first: oldFirst,
        new_first: t.first_available,
        improved: improved,
        added_dates: addedDates,
      });
    }
  }
  return changes;
}

async function main() {
  console.log('Courtdates monitor: polling ' + CONFIG.profileSlug);
  if (!fs.existsSync(CONFIG.dataDir)) fs.mkdirSync(CONFIG.dataDir, { recursive: true });

  let types = await getEventTypes();
  console.log('Discovered ' + types.length + ' event types');
  if (CONFIG.limitTypes > 0) types = types.slice(0, CONFIG.limitTypes);

  const chunks = buildMonthChunks(CONFIG.horizonMonths);
  const generatedAt = new Date().toISOString();
  const results = [];

  for (const t of types) {
    process.stdout.write('  ' + t.name + ' ... ');
    const entry = {
      name: t.name,
      slug: t.slug,
      uuid: t.uuid,
      booking_url: 'https://calendly.com/' + CONFIG.profileSlug + '/' + t.slug,
      first_available: null,
      available_count: 0,
      available_dates: [],
      scanned_through: chunks[chunks.length - 1][1],
      last_improved_at: null,
      error: null,
    };
    try {
      const dates = await scanEventType(t, chunks);
      entry.available_dates = dates;
      entry.available_count = dates.length;
      entry.first_available = dates.length > 0 ? dates[0] : null;
      console.log(
        dates.length > 0
          ? 'first open ' + dates[0] + ' (' + dates.length + ' dates)'
          : 'no availability in horizon'
      );
    } catch (e) {
      entry.error = e.message;
      console.log('ERROR: ' + e.message);
    }
    results.push(entry);
  }

  const snapshot = {
    generated_at: generatedAt,
    profile: CONFIG.profileSlug,
    timezone: CONFIG.timezone,
    horizon_months: CONFIG.horizonMonths,
    event_types: results,
  };

  const prev = loadPreviousSnapshot();
  const changes = diffSnapshots(prev, snapshot);

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(
    CHANGES_PATH,
    JSON.stringify(
      { generated_at: generatedAt, has_changes: changes.length > 0, changes: changes },
      null,
      2
    )
  );

  // Compact per-run history line: first available date per type
  const historyLine = {
    ts: generatedAt,
    firsts: {},
  };
  for (const r of results) historyLine.firsts[r.slug] = r.first_available;
  fs.appendFileSync(HISTORY_PATH, JSON.stringify(historyLine) + '\n');

  console.log(
    'Done. ' +
      changes.length +
      ' change(s) detected. Snapshot written to data/snapshot.json'
  );

  const errored = results.filter((r) => r.error);
  if (errored.length === results.length && results.length > 0) {
    // Every single type failed: likely bot protection or endpoint change.
    // Fail the workflow so it's visible.
    throw new Error('All event type scans failed. Check endpoint access.');
  }
}

main().catch((e) => {
  console.error('FATAL: ' + e.message);
  process.exit(1);
});
