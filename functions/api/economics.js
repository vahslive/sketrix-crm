// GET /api/economics?days=30      — where the money went, job by job.
// GET /api/economics?bookingId=52 — the same breakdown for one job.
//
// Admin only. This is the answer to "we charged $469, so what did we actually
// keep", which until now nothing could give: Finance showed revenue minus the
// master and called the remainder "kept by the business", when parts, card
// fees, the platform's cut and the advertising that bought the customer all
// still had to come out of it.
//
// Six lines per job, and they add up to the money in the bank:
//
//   revenue − master − parts − platform − card fee − advertising = business
//
import { getUserFromRequest } from '../_lib/auth.js';
import { masterPayoutForBooking } from '../_lib/payout.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const bookingId = Number(url.searchParams.get('bookingId')) || null;
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 0), 3650);

  const business = await env.DB.prepare(
    `SELECT master_share_percent, onsite_master_share_percent FROM businesses WHERE name = 'Mount It Right'`
  ).first();

  let where = `WHERE b.status = 'completed'`;
  const binds = [];
  if (bookingId) {
    where = `WHERE b.id = ?`;          // one job, whatever its status
    binds.push(bookingId);
  } else if (days) {
    where += ` AND b.completed_at >= datetime('now', ?)`;
    binds.push(`-${days} days`);
  }

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.name, b.address, b.status, b.completed_at, b.created_at,
            b.total_price, b.actual_total, b.payment_method, b.lead_source,
            b.master_cents, b.business_cents, b.platform_cents, b.stripe_fee_cents,
            b.stripe_split_done, b.attribution_json,
            u.name AS master_name, u.display_name AS master_display
     FROM bookings b
     LEFT JOIN users u ON u.id = b.claimed_by
     ${where}
     ORDER BY b.id DESC
     LIMIT 400`
  ).bind(...binds).all();

  const bookings = results || [];
  if (!bookings.length) {
    return Response.json({ ok: true, jobs: [], totals: emptyTotals(), adCostPerJob: {} });
  }

  // ---- parts, from the lines of each job -----------------------------
  const ids = bookings.map((b) => b.id);
  const placeholders = ids.map(() => '?').join(',');
  const { results: itemRows } = await env.DB.prepare(
    `SELECT booking_id, kind, price_cents, cost_cents, source
     FROM booking_items WHERE booking_id IN (${placeholders})`
  ).bind(...ids).all();

  const itemsByBooking = new Map();
  for (const row of itemRows || []) {
    const list = itemsByBooking.get(row.booking_id) || [];
    list.push(row);
    itemsByBooking.set(row.booking_id, list);
  }

  // ---- advertising, spread over the jobs it bought --------------------
  //
  // Spend is recorded per channel per month, because that is how the ad
  // platforms report it. Charging it to one job means dividing a month's
  // spend by the jobs that channel produced that month — an average, not a
  // fact about any single customer, and labelled as such wherever it shows.
  const { results: spendRows } = await env.DB.prepare(
    `SELECT channel, period, SUM(amount_cents) AS cents FROM ad_spend GROUP BY channel, period`
  ).all();

  // Every booking from a paid channel counts toward the divisor, including
  // ones that later cancelled: the click was paid for either way.
  const { results: countRows } = await env.DB.prepare(
    `SELECT lead_source AS channel, substr(created_at, 1, 7) AS period, COUNT(*) AS n
     FROM bookings WHERE lead_source IS NOT NULL GROUP BY lead_source, period`
  ).all();

  const bookedPerChannelMonth = {};
  for (const row of countRows || []) {
    bookedPerChannelMonth[`${row.channel}|${row.period}`] = row.n;
  }

  const adCostPerJob = {};
  for (const row of spendRows || []) {
    const key = `${row.channel}|${row.period}`;
    const n = bookedPerChannelMonth[key] || 0;
    adCostPerJob[key] = n > 0 ? Math.round(row.cents / n) : null;
  }

  // ---- put a job together ---------------------------------------------
  const jobs = [];
  for (const b of bookings) {
    const items = itemsByBooking.get(b.id) || [];
    const revenueCents = Math.round((b.actual_total ?? b.total_price ?? 0) * 100);

    const partsCents = items.reduce((sum, i) => sum + (Number(i.cost_cents) || 0), 0);

    // What Stripe actually moved beats any recomputation. Only when the split
    // never ran — a cash job, or one settled before this existed — is the
    // master's share worked out from the rules.
    let masterCents = b.master_cents;
    if (masterCents == null) {
      const payout = await masterPayoutForBooking(env, b, business);
      masterCents = payout.masterCents;
    }

    // A cash job never touched Stripe, so it carries neither the card fee nor
    // the platform's cut — showing zeros there is the truth, not a gap.
    const platformCents = b.stripe_split_done ? (b.platform_cents || 0) : 0;
    const feeCents = b.stripe_split_done ? (b.stripe_fee_cents || 0) : 0;

    const channel = b.lead_source || null;
    const period = (b.created_at || '').slice(0, 7);
    const adCents = channel ? (adCostPerJob[`${channel}|${period}`] ?? 0) : 0;

    const businessCents = revenueCents - masterCents - partsCents - platformCents - feeCents - adCents;

    jobs.push({
      id: b.id,
      name: b.name,
      address: b.address,
      status: b.status,
      completedAt: b.completed_at,
      paymentMethod: b.payment_method,
      master: b.master_display || b.master_name,
      channel,
      itemised: items.length > 0,
      // Costs we have no figure for read as free, and a margin that looks
      // perfect is usually a margin nobody has filled in.
      partsPriced: items.some((i) => (Number(i.cost_cents) || 0) > 0),
      adEstimated: adCents > 0,
      revenue: revenueCents / 100,
      master_pay: masterCents / 100,
      parts: partsCents / 100,
      platform: platformCents / 100,
      cardFee: feeCents / 100,
      advertising: adCents / 100,
      business: businessCents / 100,
      marginPercent: revenueCents > 0 ? (businessCents / revenueCents) * 100 : null,
    });
  }

  const sum = (key) => jobs.reduce((total, job) => total + job[key], 0);
  const totals = {
    jobs: jobs.length,
    revenue: sum('revenue'),
    master_pay: sum('master_pay'),
    parts: sum('parts'),
    platform: sum('platform'),
    cardFee: sum('cardFee'),
    advertising: sum('advertising'),
    business: sum('business'),
  };
  totals.marginPercent = totals.revenue > 0 ? (totals.business / totals.revenue) * 100 : null;

  // Worth surfacing rather than burying: a job with no line items has no parts
  // figure, and its margin is flattering by exactly the cost of the bracket.
  totals.jobsWithoutItems = jobs.filter((j) => !j.itemised).length;
  totals.jobsWithoutPartCost = jobs.filter((j) => j.itemised && !j.partsPriced).length;

  return Response.json({ ok: true, days, jobs, totals });
}

function emptyTotals() {
  return {
    jobs: 0, revenue: 0, master_pay: 0, parts: 0, platform: 0,
    cardFee: 0, advertising: 0, business: 0, marginPercent: null,
    jobsWithoutItems: 0, jobsWithoutPartCost: 0,
  };
}
