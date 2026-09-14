// The one place a job's price is worked out.
//
// It used to be worked out in the browser, and the server recorded whatever
// total the page sent. That made two things impossible and one thing unsafe:
// the app couldn't add a soundbar on site and recalculate, the admin couldn't
// change a price without a code change, and anyone could book a $600 job for a
// dollar by editing the request. All three are the same root cause — the price
// list wasn't on the server.
//
// The rules, unchanged from the booking form:
//   · a television costs dismount + size + bracket + wall + wires
//   · the most expensive television is charged in full, every additional one
//     gets the business's discount (15% today) — sorted by price, so the
//     discount always lands in the customer's favour
//   · add-ons are charged once per booking, whatever the number of televisions
//   · the result is rounded to whole dollars
//
// What is new is that the same calculation also emits LINE ITEMS, and each
// line knows whether it is labour or a part. That distinction is money: the
// master's percentage is pay for work, and paying it on a bracket the business
// bought means paying a wage on stock. On a $99 mount costing $50, the old
// split handed the master $40 of the $50 margin.

const TV_KEYS = ['dismount', 'size', 'bracket', 'wall', 'wires'];

/** Loads the active price list as a { code: {price, scope, ...} } map. */
export async function loadPrices(env) {
  const { results } = await env.DB.prepare(
    `SELECT group_key, code, label, price, scope, sort_order, kind, cost, requires_size
     FROM service_prices WHERE active = 1 ORDER BY group_key, sort_order`
  ).all();

  const byCode = {};
  for (const row of results) byCode[row.code] = row;
  return { rows: results, byCode };
}

/** The discount applied to every television after the most expensive one. */
export async function additionalTvDiscount(env, businessName = 'Mount It Right') {
  const row = await env.DB.prepare(
    `SELECT additional_tv_discount_percent AS pct FROM businesses WHERE name = ?`
  ).bind(businessName).first();
  const pct = Number(row?.pct);
  return Number.isFinite(pct) ? pct : 15;
}

/** What one television costs before any multi-TV discount. */
export function priceOneTv(tv, byCode) {
  let sum = 0;
  for (const key of TV_KEYS) {
    const code = tv?.[key];
    if (!code) continue;
    const option = byCode[code];
    if (option) sum += option.price;
  }
  return sum;
}

/**
 * The total for a booking, plus the lines that produced it.
 *
 * Lines are in cents. The discount on additional televisions is applied to
 * each of that TV's lines rather than added as a separate negative row, so
 * the lines always sum to exactly the amount charged and a receipt never has
 * to explain a mysterious deduction.
 *
 * @param {Array<object>} tvs     one entry per television, each holding the
 *                                selected option codes
 * @param {Array<string>} addons  add-on codes, charged once for the booking
 * @param {object} byCode         price list from loadPrices()
 * @param {number} discountPct    discount on each television after the dearest
 * @returns {{ total:number, items:Array, lines:Array }}
 */
export function computeTotal(tvs, addons, byCode, discountPct) {
  const list = Array.isArray(tvs) && tvs.length ? tvs : [];
  const priced = list
    .map((tv) => ({ tv, price: priceOneTv(tv, byCode) }))
    .sort((a, b) => b.price - a.price);

  const items = [];
  const lines = [];
  let totalCents = 0;

  priced.forEach((entry, index) => {
    const discount = index === 0 ? 0 : discountPct;
    const factor = 1 - discount / 100;

    for (const key of TV_KEYS) {
      const code = entry.tv?.[key];
      if (!code) continue;
      const option = byCode[code];
      if (!option || option.price === 0) continue;   // "I already have one" is not a line

      const priceCents = Math.round(option.price * 100 * factor);
      totalCents += priceCents;
      items.push({
        code,
        label: option.label,
        kind: option.kind === 'material' ? 'material' : 'labor',
        priceCents,
        // Cost is a snapshot: what this part cost us on the day, so a later
        // price change never rewrites the margin on jobs already done.
        costCents: Math.round((option.cost || 0) * 100),
        discountPercent: discount,
        tvIndex: index + 1,
      });
    }

    lines.push({
      kind: 'tv',
      index: index + 1,
      options: TV_KEYS.map((k) => entry.tv?.[k]).filter(Boolean),
      price: entry.price,
      discountPercent: discount,
      charged: Math.round(entry.price * factor),
    });
  });

  for (const code of addons || []) {
    const option = byCode[code];
    if (!option) continue;
    const priceCents = Math.round(option.price * 100);
    totalCents += priceCents;
    items.push({
      code,
      label: option.label,
      kind: option.kind === 'material' ? 'material' : 'labor',
      priceCents,
      costCents: Math.round((option.cost || 0) * 100),
      discountPercent: 0,
      tvIndex: null,
    });
    lines.push({ kind: 'addon', code, label: option.label, charged: option.price });
  }

  return { total: Math.round(totalCents / 100), totalCents, items, lines };
}

/**
 * Writes the line items for a booking, replacing anything previously recorded
 * as coming from the booking itself. Items added on site are left alone —
 * recalculating a booking must never quietly delete the soundbar the customer
 * agreed to at their door.
 */
export async function saveBookingItems(env, bookingId, items) {
  const statements = [
    env.DB.prepare(`DELETE FROM booking_items WHERE booking_id = ? AND source = 'booking'`).bind(bookingId),
  ];

  for (const item of items) {
    statements.push(env.DB.prepare(
      `INSERT INTO booking_items
        (booking_id, code, label, kind, price_cents, cost_cents, discount_percent, tv_index, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booking')`
    ).bind(
      bookingId, item.code, item.label, item.kind,
      item.priceCents, item.costCents, item.discountPercent, item.tvIndex
    ));
  }

  if (statements.length > 1) await env.DB.batch(statements);
}
