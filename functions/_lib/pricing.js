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

const TV_KEYS = ['dismount', 'size', 'bracket', 'wall', 'wires'];

/** Loads the active price list as a { code: {price, scope, ...} } map. */
export async function loadPrices(env) {
  const { results } = await env.DB.prepare(
    `SELECT group_key, code, label, price, scope, sort_order
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
 * The total for a booking.
 *
 * @param {Array<object>} tvs     one entry per television, each holding the
 *                                selected option codes
 * @param {Array<string>} addons  add-on codes, charged once for the booking
 * @param {object} byCode         price list from loadPrices()
 * @param {number} discountPct    discount on each television after the dearest
 * @returns {{ total:number, lines:Array }} the total plus the line items that
 *          produced it — worth keeping, because a receipt that just says $257
 *          invites an argument no one can settle afterwards.
 */
export function computeTotal(tvs, addons, byCode, discountPct) {
  const list = Array.isArray(tvs) && tvs.length ? tvs : [];
  const priced = list
    .map((tv) => ({ tv, price: priceOneTv(tv, byCode) }))
    .sort((a, b) => b.price - a.price);

  const lines = [];
  let total = 0;

  priced.forEach((entry, index) => {
    const discounted = index === 0 ? entry.price : entry.price * (1 - discountPct / 100);
    total += discounted;
    lines.push({
      kind: 'tv',
      index: index + 1,
      options: TV_KEYS.map((k) => entry.tv?.[k]).filter(Boolean),
      price: entry.price,
      discountPercent: index === 0 ? 0 : discountPct,
      charged: Math.round(discounted),
    });
  });

  for (const code of addons || []) {
    const option = byCode[code];
    if (!option) continue;
    total += option.price;
    lines.push({ kind: 'addon', code, label: option.label, charged: option.price });
  }

  return { total: Math.round(total), lines };
}
