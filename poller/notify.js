/**
 * notify.js - Email notifications for newly opened court booking dates
 *
 * Reads data/changes.json produced by poll.js. If there are changes,
 * fetches subscribers from Supabase (REST API, service role key) and
 * sends one digest email per matching subscriber via Resend.
 *
 * Zero dependencies. Requires Node 18+.
 *
 * Required env:
 *   SUPABASE_URL          e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  service role key (server-side only, never in WordPress)
 *   RESEND_API_KEY        from resend.com
 *   FROM_EMAIL            e.g. "Courtready Alerts <alerts@courtready.ca>" (domain must be verified in Resend)
 *   DASHBOARD_URL         public page hosting the dashboard, used for unsubscribe links
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CHANGES_PATH = path.join(__dirname, '..', 'data', 'changes.json');

const ENV = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  resendApiKey: process.env.RESEND_API_KEY,
  fromEmail: process.env.FROM_EMAIL,
  dashboardUrl: process.env.DASHBOARD_URL || 'https://courtdates.ca',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(isoDate) {
  if (!isoDate) return 'none found';
  const parts = isoDate.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return d.toLocaleDateString('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

async function getSubscribers() {
  const url =
    ENV.supabaseUrl +
    '/rest/v1/courtdates_subscribers?select=email,hearing_types,unsubscribe_token';
  const res = await fetch(url, {
    headers: {
      apikey: ENV.supabaseServiceKey,
      Authorization: 'Bearer ' + ENV.supabaseServiceKey,
    },
  });
  if (!res.ok) {
    throw new Error('Supabase fetch failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  }
  return res.json();
}

function subscriberMatches(subscriber, changedSlugs) {
  const prefs = Array.isArray(subscriber.hearing_types) ? subscriber.hearing_types : ['all'];
  if (prefs.indexOf('all') !== -1) return changedSlugs;
  return changedSlugs.filter((slug) => prefs.indexOf(slug) !== -1);
}

function buildEmailHtml(changes, unsubscribeToken) {
  const rows = changes
    .map((c) => {
      const improvedNote = c.improved
        ? '<div style="color:#e28a64;font-weight:bold;font-size:13px;margin-top:2px;">Earlier than before' +
          (c.old_first ? ' (was ' + formatDate(c.old_first) + ')' : '') +
          '</div>'
        : '';
      const addedNote =
        c.added_dates.length > 0
          ? '<div style="color:#555;font-size:13px;margin-top:2px;">' +
            c.added_dates.length +
            ' new date' +
            (c.added_dates.length === 1 ? '' : 's') +
            ' opened' +
            (c.added_dates.length <= 5 ? ': ' + c.added_dates.join(', ') : '') +
            '</div>'
          : '';
      return (
        '<tr><td style="padding:14px 0;border-bottom:1px solid #eee;">' +
        '<div style="font-weight:bold;color:#2f2f2f;font-size:15px;">' + c.name + '</div>' +
        '<div style="color:#2f2f2f;font-size:14px;margin-top:4px;">First open date: <strong>' +
        formatDate(c.new_first) +
        '</strong></div>' +
        improvedNote +
        addedNote +
        '<div style="margin-top:8px;"><a href="' + c.booking_url +
        '" style="display:inline-block;background:#e28a64;color:#ffffff;text-decoration:none;padding:8px 16px;border-radius:4px;font-size:13px;font-weight:bold;">Book this hearing type</a></div>' +
        '</td></tr>'
      );
    })
    .join('');

  const sep = ENV.dashboardUrl.indexOf('?') === -1 ? '?' : '&';
  const unsubscribeUrl = ENV.dashboardUrl + sep + 'crtdm_unsub=' + unsubscribeToken;

  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;">' +
    '<h1 style="color:#2f2f2f;font-size:20px;margin:0 0 4px;">New court booking dates are open</h1>' +
    '<p style="color:#555;font-size:14px;margin:0 0 20px;">Toronto Superior Court of Justice, Calendly booking pages</p>' +
    '<table style="width:100%;border-collapse:collapse;">' + rows + '</table>' +
    '<p style="color:#999;font-size:12px;margin-top:24px;line-height:1.5;">' +
    'You are receiving this because you subscribed to court date alerts on Courtready. ' +
    'Dates can be booked by others quickly; availability is not guaranteed. ' +
    '<a href="' + unsubscribeUrl + '" style="color:#999;">Unsubscribe</a>' +
    '</p>' +
    '</div>'
  );
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + ENV.resendApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: ENV.fromEmail, to: [to], subject: subject, html: html }),
  });
  if (!res.ok) {
    console.warn('  Send failed for ' + to + ': HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    return false;
  }
  return true;
}

async function main() {
  if (!fs.existsSync(CHANGES_PATH)) {
    console.log('No changes.json found; nothing to do.');
    return;
  }
  const changesFile = JSON.parse(fs.readFileSync(CHANGES_PATH, 'utf8'));
  if (!changesFile.has_changes) {
    console.log('No changes this run; no emails sent.');
    return;
  }

  const missing = ['supabaseUrl', 'supabaseServiceKey', 'resendApiKey', 'fromEmail'].filter(
    (k) => !ENV[k]
  );
  if (missing.length > 0) {
    console.warn('Changes detected but env vars missing (' + missing.join(', ') + '); skipping notifications.');
    return;
  }

  const changes = changesFile.changes;
  const changedSlugs = changes.map((c) => c.slug);
  const changesBySlug = {};
  for (const c of changes) changesBySlug[c.slug] = c;

  const subscribers = await getSubscribers();
  console.log(changes.length + ' change(s), ' + subscribers.length + ' subscriber(s)');

  let sent = 0;
  for (const sub of subscribers) {
    const matchedSlugs = subscriberMatches(sub, changedSlugs);
    if (matchedSlugs.length === 0) continue;

    const matchedChanges = matchedSlugs.map((slug) => changesBySlug[slug]);
    const subject =
      matchedChanges.length === 1
        ? 'New dates open: ' + matchedChanges[0].name
        : 'New dates open for ' + matchedChanges.length + ' hearing types';

    const ok = await sendEmail(sub.email, subject, buildEmailHtml(matchedChanges, sub.unsubscribe_token));
    if (ok) sent += 1;
    await sleep(600); // Resend rate limit is 2 req/s
  }

  console.log('Sent ' + sent + ' notification email(s).');
}

main().catch((e) => {
  console.error('FATAL: ' + e.message);
  process.exit(1);
});
