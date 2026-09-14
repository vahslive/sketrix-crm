// GET  /api/bookings/:id/items — the lines this job is made of.
// POST /api/bookings/:id/items { add: ['addon_soundbar', ...], remove: [itemId] }
//      — the master, standing in the customer's living room, adds the thing
//        nobody thought of when they booked. The total is recalculated here
//        and written back, so the card is charged the new figure and the
//        receipt explains it.
//
// This is the endpoint behind "he wanted a soundbar as well". Everything it
// adds is marked on_site, which is what earns the master the higher rate and
// what stops "book the minimum, add it at the door" from becoming a strategy.
import { getUserFromRequest } from '../../../_lib/auth.js';
import { loadPrices } from '../../../_lib/pricing.js';
import { loadItems, itemsTotalCents } from '../../../_lib/payout.js';

// Enough for a genuinely big job, small enough that a stuck loop in the app
// can't write a thousand rows.
const MAX_ADDS_PER_CALL = 12;

async function bookingFor(env, user, id) {
  const booking = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  if (!booking) return null;
  if (user.role !== 'admin' && booking.claimed_by !== user.id) return null;
  return booking;
}

export async function onRequestGet({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const booking = await bookingFor(env, user, params.id);
  if (!booking) return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });

  const items = await loadItems(env, params.id);
  return Response.json({
    ok: true,
    items,
    total: Math.round(itemsTotalCents(items) / 100),
    // A booking taken before line items existed has none, and never will.
    // The app needs to know that so it can show the old single figure instead
    // of an empty list that looks like a bug.
    itemised: items.length > 0,
    bookedTotal: booking.total_price,
    currentTotal: booking.actual_total ?? booking.total_price,
  });
}

export async function onRequestPost({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const booking = await bookingFor(env, user, params.id);
  if (!booking) return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });

  if (booking.status === 'completed') {
    return Response.json(
      { ok: false, error: 'This job is already closed. Reopen it before changing what was done.' },
      { status: 400 }
    );
  }
  // Once the card has gone through, the amount is fixed at the bank. Adding a
  // line afterwards would leave the receipt saying one thing and the customer's
  // statement another.
  if (booking.stripe_split_done) {
    return Response.json(
      { ok: false, error: 'Payment has already been taken for this job.' },
      { status: 400 }
    );
  }

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const add = Array.isArray(body.add) ? body.add.slice(0, MAX_ADDS_PER_CALL) : [];
  const remove = Array.isArray(body.remove) ? body.remove : [];

  if (!add.length && !remove.length) {
    return Response.json({ ok: false, error: 'Nothing to add or remove.' }, { status: 400 });
  }

  const { byCode } = await loadPrices(env);
  const statements = [];

  for (const code of add) {
    const option = byCode[String(code)];
    if (!option) continue;   // an unknown code is a stale app, not an instruction
    statements.push(env.DB.prepare(
      `INSERT INTO booking_items
        (booking_id, code, label, kind, price_cents, cost_cents, discount_percent, tv_index, source, added_by)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 'on_site', ?)`
    ).bind(
      params.id, option.code, option.label,
      option.kind === 'material' ? 'material' : 'labor',
      Math.round(option.price * 100), Math.round((option.cost || 0) * 100),
      user.id
    ));
  }

  // Only on-site lines can be taken back off. The booking itself is what the
  // customer agreed to online; removing part of it is a refund decision, not
  // something to do from a phone at someone's door.
  for (const itemId of remove) {
    statements.push(env.DB.prepare(
      `DELETE FROM booking_items WHERE id = ? AND booking_id = ? AND source = 'on_site'`
    ).bind(Number(itemId), params.id));
  }

  if (!statements.length) {
    return Response.json({ ok: false, error: 'None of those services exist in the price list.' }, { status: 400 });
  }

  await env.DB.batch(statements);

  const items = await loadItems(env, params.id);
  const total = Math.round(itemsTotalCents(items) / 100);

  // actual_total is what the card will be charged and what the receipt shows.
  // Writing it here — rather than at completion — is what makes the new figure
  // real for every later step.
  await env.DB.prepare(`UPDATE bookings SET actual_total = ? WHERE id = ?`)
    .bind(total, params.id).run();

  return Response.json({ ok: true, items, total, added: add.length, removed: remove.length });
}
