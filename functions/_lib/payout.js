// What the master is owed on a job.
//
// The old rule was one line: a flat percentage of the total. It was wrong in
// two ways that only show up once you look at a real invoice.
//
// First, it paid a labour percentage on parts. A $99 bracket costs the
// business around $50; at 40% the master took $40 of that $50 margin, so the
// business earned about five dollars for buying, stocking and warrantying the
// hardware. The master's percentage is pay for work, and fitting the bracket
// is already paid for by the television's base price.
//
// Second, it gave the master no reason to sell anything at the door. Work the
// master finds on site — the soundbar nobody booked, the cables the customer
// only regrets once the TV is up — pays a higher rate, because it is the one
// kind of revenue that exists solely because the master asked.
//
// Anything added before the job started is not a sale, it is the booking. The
// timestamp decides, which is why items record when they were added: without
// that line, "book the minimum and add it on site" becomes the way to earn
// more on every job.
const MATERIAL = 'material';

/**
 * @param {Array} items       rows from booking_items
 * @param {object} business   row from businesses
 * @returns {{masterCents:number, labourCents:number, onSiteLabourCents:number,
 *            materialCents:number, costCents:number}}
 */
export function masterPayout(items, business) {
  const baseRate = Number(business?.master_share_percent);
  const onSiteRate = Number(business?.onsite_master_share_percent);

  const base = Number.isFinite(baseRate) ? baseRate / 100 : 0.40;
  const onSite = Number.isFinite(onSiteRate) ? onSiteRate / 100 : base;

  let labourCents = 0;
  let onSiteLabourCents = 0;
  let materialCents = 0;
  let costCents = 0;

  for (const item of items || []) {
    const price = Number(item.price_cents) || 0;
    costCents += Number(item.cost_cents) || 0;

    if (item.kind === MATERIAL) {
      materialCents += price;
      continue;   // parts never carry a wage, whoever sold them
    }
    if (item.source === 'on_site') onSiteLabourCents += price;
    else labourCents += price;
  }

  return {
    masterCents: Math.round(labourCents * base + onSiteLabourCents * onSite),
    labourCents,
    onSiteLabourCents,
    materialCents,
    costCents,
  };
}

/** The items of a booking, oldest first. */
export async function loadItems(env, bookingId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM booking_items WHERE booking_id = ? ORDER BY id`
  ).bind(bookingId).all();
  return results || [];
}

/**
 * The master's cut, falling back to the old flat percentage for bookings taken
 * before line items existed. Those jobs have no items and never will; paying
 * them zero because the new rule found no labour lines would be a bug with a
 * bank transfer attached.
 */
export async function masterPayoutForBooking(env, booking, business) {
  const items = await loadItems(env, booking.id);

  if (!items.length) {
    const rate = Number(business?.master_share_percent);
    const base = Number.isFinite(rate) ? rate / 100 : 0.40;
    const totalCents = Math.round((booking.actual_total ?? booking.total_price ?? 0) * 100);
    return {
      masterCents: Math.round(totalCents * base),
      labourCents: totalCents,
      onSiteLabourCents: 0,
      materialCents: 0,
      costCents: 0,
      legacy: true,
    };
  }

  return { ...masterPayout(items, business), legacy: false };
}

/** Sum of everything charged on a booking, in cents. */
export function itemsTotalCents(items) {
  return (items || []).reduce((sum, item) => sum + (Number(item.price_cents) || 0), 0);
}
