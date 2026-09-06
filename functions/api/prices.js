// GET /api/prices — public, no auth.
//
// The booking form, the master's app and the admin all read the price list
// from here, so there is exactly one set of numbers in the business. Public on
// purpose: these prices are printed on the website for anyone to see, and
// requiring a key would only stop the booking form from using them.
import { loadPrices, additionalTvDiscount } from '../_lib/pricing.js';

export async function onRequestGet({ env }) {
  const { rows } = await loadPrices(env);

  // Grouped the way the booking form asks its questions, in display order.
  const groups = {};
  for (const row of rows) {
    (groups[row.group_key] ||= []).push({
      id: row.code,
      label: row.label,
      price: row.price,
      scope: row.scope,
    });
  }

  return Response.json({
    ok: true,
    groups,
    additionalTvDiscountPercent: await additionalTvDiscount(env),
  }, {
    // A minute of caching keeps the booking form snappy without making a price
    // change wait around — the admin edits a price and sees it live almost at
    // once, which is the whole point of moving the list here.
    headers: { 'Cache-Control': 'public, max-age=60' },
  });
}
