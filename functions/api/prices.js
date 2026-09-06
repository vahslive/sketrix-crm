// GET  /api/prices — public, no auth. The price list everything reads.
// POST /api/prices — admin only. Changes prices, labels and the multi-TV discount.
//
// The booking form, the master's app and the admin all read from here, so there
// is exactly one set of numbers in the business. Public on the read side by
// design: these prices are printed on the website for anyone to see, and
// requiring a key would only stop the booking form from using them.
import { getUserFromRequest } from '../_lib/auth.js';
import { loadPrices, additionalTvDiscount } from '../_lib/pricing.js';

// A guard against a slipped finger, not against malice — an admin typing 1900
// instead of 190 should be stopped before a customer is quoted it.
const MAX_PRICE = 2000;

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
    // Short, because the admin edits a price and immediately wants to see it
    // in the booking form.
    headers: { 'Cache-Control': 'public, max-age=30' },
  });
}

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const items = Array.isArray(body.prices) ? body.prices : [];
  const { byCode } = await loadPrices(env);

  const updates = [];
  for (const item of items) {
    const code = String(item?.code || '');
    if (!byCode[code]) continue; // an unknown code is a stale page, not an instruction

    const price = Number(item.price);
    if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE) {
      return Response.json(
        { ok: false, error: `"${byCode[code].label}" — a price must be a whole number between 0 and ${MAX_PRICE}.` },
        { status: 400 }
      );
    }

    const label = item.label != null ? String(item.label).trim() : byCode[code].label;
    if (!label) {
      return Response.json({ ok: false, error: 'An option needs a name customers can read.' }, { status: 400 });
    }

    if (price !== byCode[code].price || label !== byCode[code].label) {
      updates.push({ code, price, label });
    }
  }

  for (const u of updates) {
    await env.DB.prepare(
      `UPDATE service_prices SET price = ?, label = ?, updated_at = datetime('now') WHERE code = ?`
    ).bind(u.price, u.label, u.code).run();
  }

  let discountChanged = false;
  if (body.additionalTvDiscountPercent != null) {
    const pct = Number(body.additionalTvDiscountPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
      return Response.json({ ok: false, error: 'The additional-TV discount has to be between 0 and 50 percent.' }, { status: 400 });
    }
    await env.DB.prepare(
      `UPDATE businesses SET additional_tv_discount_percent = ? WHERE name = 'Mount It Right'`
    ).bind(pct).run();
    discountChanged = true;
  }

  // Prices change from here on. Bookings already taken keep the total that was
  // agreed with the customer — total_price is stored on the booking, never
  // recalculated — so nobody's quote moves under them.
  return Response.json({ ok: true, updated: updates.length, discountChanged });
}
