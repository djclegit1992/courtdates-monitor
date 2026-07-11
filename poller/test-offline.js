/**
 * test-offline.js - Runs poll.js against a mocked Calendly API.
 * Usage: node poller/test-offline.js run1|run2
 * run1 seeds a baseline; run2 opens earlier + new dates to verify diffing.
 */
'use strict';

const scenario = process.argv[2] || 'run1';

const EVENT_TYPES = [
  { name: 'Civil Motion (Short)', slug: 'civil-motion-short', uuid: 'AAA111', hidden: false },
  { name: 'Civil Motion (Long)', slug: 'civil-motion-long', uuid: 'BBB222', hidden: false },
  { name: 'Case Conference', slug: 'case-conference', uuid: 'CCC333', hidden: false },
];

const AVAILABILITY = {
  run1: {
    AAA111: ['2026-11-03', '2026-11-17'],
    BBB222: ['2027-02-09'],
    CCC333: [],
  },
  run2: {
    AAA111: ['2026-09-21', '2026-11-03', '2026-11-17'], // earlier date opened
    BBB222: ['2027-02-09', '2027-02-23'],               // new (not earlier) date
    CCC333: [],                                          // still nothing
  },
};

global.fetch = async function (url) {
  const body = (obj) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
  });

  if (url.indexOf('/profiles/') !== -1) {
    return body({ collection: EVENT_TYPES });
  }
  const m = url.match(/event_types\/([A-Z0-9]+)\/calendar\/range.*range_start=(\d{4}-\d{2}-\d{2})&range_end=(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const uuid = m[1];
    const start = m[2];
    const end = m[3];
    const dates = AVAILABILITY[scenario][uuid] || [];
    const days = dates
      .filter((d) => d >= start && d <= end)
      .map((d) => ({ date: d, status: 'available', spots: [{}], enabled: true }));
    return body({ days: days });
  }
  return { ok: false, status: 404, text: async () => 'not found' };
};

process.env.REQUEST_DELAY_MS = '0';
process.env.HORIZON_MONTHS = '10';
require('./poll.js');
