// GET  /api/marketing?days=30 — admin only. What each channel, campaign and
//      creative actually produced, next to what it cost.
// POST /api/marketing — admin only. Records what was spent on a channel or a
//      campaign in a given month.
//
// The question this exists to answer is not "how many leads" — that number
// flatters every channel equally. It is "what did a booking cost, and did the
// work that followed it earn more than that". So everything here is counted
// twice: booked (what customers agreed to) and completed (what was actually
// finished and charged). Advertising that produces bookings which cancel is
// advertising that produced nothing, and only the second column shows it.
import { getUserFromRequest } from '../_lib/auth.js';

const MAX_SPEND_CENTS = 100000 * 100;   // $100k in a month, as a typo guard

/** An empty string rather than NULL, so uniqueness works in SQLite. */
function norm(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function bucketFor(map, key, label) {
  let row = map.get(key);
  if (!row) {
    row = { key, label, booked: 0, bookedValue: 0, completed: 0, completedValue: 0, cancelled: 0 };
    map.set(key, row);
  }
  return row;
}

function addBooking(row, b) {
  row.booked += 1;
  row.bookedValue += b.total_price || 0;
  if (b.status === 'completed') {
    row.completed += 1;
    row.completedValue += (b.actual_total ?? b.total_price ?? 0);
  }
  if (b.status === 'cancelled') row.cancelled += 1;
}

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 0), 3650);

  // days=0 means everything. Otherwise SQLite does the date arithmetic, so the
  // cutoff is computed in the same clock the rows were written with.
  const where = days ? `WHERE created_at >= datetime('now', ?)` : '';
  const binds = days ? [`-${days} days`] : [];

  const { results } = await env.DB.prepare(
    `SELECT id, created_at, status, source, lead_source, attribution_json,
            total_price, actual_total, name, address, booking_date
     FROM bookings ${where}
     ORDER BY id DESC`
  ).bind(...binds).all();

  const bookings = results || [];

  const channels = new Map();
  const campaigns = new Map();
  const creatives = new Map();
  const pages = new Map();
  const recent = [];

  for (const b of bookings) {
    let attr = {};
    try { attr = b.attribution_json ? JSON.parse(b.attribution_json) : {}; } catch { attr = {}; }

    // A booking taken over the phone has no attribution and never will — it is
    // its own channel rather than a gap in the data.
    const channel = b.lead_source || (b.source && b.source !== 'online' ? b.source : 'direct');
    const campaign = norm(attr.utm_campaign) || '(no campaign)';
    const creative = norm(attr.utm_content) || '(no creative)';
    const page = norm(attr.page) || 'home';

    addBooking(bucketFor(channels, channel, channel), b);
    addBooking(bucketFor(pages, page, page), b);

    // Campaign and creative rows only mean something for traffic that carried
    // tags. Lumping organic bookings under "(no campaign)" would make the
    // best-performing campaign always be the one that doesn't exist.
    if (attr.utm_campaign || attr.utm_content) {
      const camp = bucketFor(campaigns, `${channel}|${campaign}`, campaign);
      addBooking(camp, b);
      camp.channel = channel;

      const cre = bucketFor(creatives, `${channel}|${campaign}|${creative}`, creative);
      addBooking(cre, b);
      cre.channel = channel;
      cre.campaign = campaign;
    }

    if (recent.length < 60) {
      recent.push({
        id: b.id,
        created_at: b.created_at,
        status: b.status,
        name: b.name,
        address: b.address,
        total: b.actual_total ?? b.total_price ?? 0,
        channel,
        campaign: attr.utm_campaign || null,
        creative: attr.utm_content || null,
        page,
      });
    }
  }

  // Spend is entered by hand, by month. Matching it to bookings by month keeps
  // the arithmetic honest without pretending we know which dollar bought which
  // job — nobody's ad platform can tell you that either.
  const spendRows = await env.DB.prepare(
    `SELECT channel, campaign, period, amount_cents, note FROM ad_spend ORDER BY period DESC`
  ).all();
  const spend = spendRows.results || [];

  // Only the months the report actually covers count toward cost.
  const months = new Set(bookings.map((b) => (b.created_at || '').slice(0, 7)).filter(Boolean));
  const inRange = (row) => !days || months.has(row.period);

  const spendByChannel = {};
  const spendByCampaign = {};
  for (const row of spend) {
    if (!inRange(row)) continue;
    spendByChannel[row.channel] = (spendByChannel[row.channel] || 0) + row.amount_cents;
    if (row.campaign) {
      const key = `${row.channel}|${row.campaign}`;
      spendByCampaign[key] = (spendByCampaign[key] || 0) + row.amount_cents;
    }
  }

  const finish = (map, spendMap) => [...map.values()].map((row) => {
    const cents = spendMap ? (spendMap[row.key] || 0) : 0;
    return {
      ...row,
      spend: cents / 100,
      costPerBooking: cents && row.booked ? cents / 100 / row.booked : null,
      // Return on the work that actually happened, not on what was promised.
      returnOnSpend: cents ? row.completedValue / (cents / 100) : null,
    };
  }).sort((a, b) => b.completedValue - a.completedValue || b.booked - a.booked);

  const channelRows = finish(channels, spendByChannel);

  // Cost per booking has to be measured against the bookings the money
  // actually bought. Dividing ad spend by every booking — including the ones
  // that walked in from Google for free — makes any campaign look cheap, and
  // makes it look cheaper the better the rest of the business does.
  const paid = channelRows.filter((r) => r.spend > 0);
  const paidBookings = paid.reduce((s, r) => s + r.booked, 0);
  const paidCompletedValue = paid.reduce((s, r) => s + r.completedValue, 0);
  const totalSpend = Object.values(spendByChannel).reduce((s, c) => s + c, 0) / 100;

  return Response.json({
    ok: true,
    days,
    totals: {
      bookings: bookings.length,
      completed: bookings.filter((b) => b.status === 'completed').length,
      bookedValue: bookings.reduce((s, b) => s + (b.total_price || 0), 0),
      completedValue: bookings
        .filter((b) => b.status === 'completed')
        .reduce((s, b) => s + (b.actual_total ?? b.total_price ?? 0), 0),
      spend: totalSpend,
      paidBookings,
      paidCompletedValue,
      costPerBooking: totalSpend && paidBookings ? totalSpend / paidBookings : null,
      returnOnSpend: totalSpend ? paidCompletedValue / totalSpend : null,
    },
    channels: channelRows,
    campaigns: finish(campaigns, spendByCampaign),
    creatives: finish(creatives, null),
    pages: finish(pages, null),
    spend,
    recent,
  });
}

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const channel = norm(body.channel, 60).toLowerCase();
  const campaign = norm(body.campaign);
  const period = norm(body.period, 7);
  const note = norm(body.note, 200);

  if (!channel) {
    return Response.json({ ok: false, error: 'Which channel was this spent on?' }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return Response.json({ ok: false, error: 'Pick a month in the form 2026-09.' }, { status: 400 });
  }

  const amountCents = Math.round(Number(body.amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents < 0 || amountCents > MAX_SPEND_CENTS) {
    return Response.json({ ok: false, error: 'Enter an amount between 0 and 100,000 dollars.' }, { status: 400 });
  }

  // Zero means "I entered this by mistake", so it removes the row rather than
  // leaving a line of nothing in the report.
  if (amountCents === 0) {
    await env.DB.prepare(
      `DELETE FROM ad_spend WHERE channel = ? AND campaign = ? AND period = ?`
    ).bind(channel, campaign, period).run();
    return Response.json({ ok: true, deleted: true });
  }

  await env.DB.prepare(
    `INSERT INTO ad_spend (channel, campaign, period, amount_cents, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel, campaign, period)
     DO UPDATE SET amount_cents = excluded.amount_cents, note = excluded.note`
  ).bind(channel, campaign, period, amountCents, note || null).run();

  return Response.json({ ok: true });
}
