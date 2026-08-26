// POST /api/stripe/split-payment { bookingId }
// Called right after the app confirms a Tap to Pay charge succeeded.
// Splits the money: master gets their share, the business gets theirs,
// and Sketrix's cut simply stays on the platform account — it's never
// transferred out, so there's nothing to configure for that part.
// Idempotent: safe to call more than once for the same booking.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }
  const { bookingId } = body;

  const booking = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return Response.json({ ok: false, error: 'Job not found' }, { status: 404 });
  if (booking.stripe_split_done) return Response.json({ ok: true, alreadySplit: true });
  if (!booking.stripe_payment_intent_id) {
    return Response.json({ ok: false, error: 'No payment on file for this job' }, { status: 400 });
  }

  // Always re-confirm against Stripe itself before moving any money —
  // never trust the client's word alone that a charge succeeded.
  const intent = await stripeRequest(env, 'GET', `payment_intents/${booking.stripe_payment_intent_id}`);
  if (intent.status !== 'succeeded') {
    return Response.json({ ok: false, error: `Payment not yet succeeded (status: ${intent.status})` }, { status: 400 });
  }

  const master = await env.DB.prepare(`SELECT stripe_account_id FROM users WHERE id = ?`).bind(booking.claimed_by).first();
  const business = await env.DB.prepare(`SELECT * FROM businesses WHERE name = 'Mount It Right'`).first();

  if (!master?.stripe_account_id) {
    return Response.json({ ok: false, error: "This master hasn't finished Stripe payout setup yet." }, { status: 400 });
  }
  if (!business?.stripe_account_id) {
    return Response.json({ ok: false, error: "Mount It Right hasn't finished Stripe payout setup yet." }, { status: 400 });
  }

  const totalCents = intent.amount_received;
  const masterCents = Math.round(totalCents * (business.master_share_percent / 100));
  // Business gets whatever's left after the master's cut and the
  // platform's cut are set aside — guarantees the shares always add up
  // exactly to the total, with no stray penny lost or created to rounding.
  const platformCents = Math.round(totalCents * (business.platform_fee_percent / 100));
  const businessCents = totalCents - masterCents - platformCents;

  await stripeRequest(env, 'POST', 'transfers', {
    amount: masterCents,
    currency: 'usd',
    destination: master.stripe_account_id,
    source_transaction: intent.latest_charge,
    metadata: { booking_id: String(bookingId), share: 'master' },
  });

  await stripeRequest(env, 'POST', 'transfers', {
    amount: businessCents,
    currency: 'usd',
    destination: business.stripe_account_id,
    source_transaction: intent.latest_charge,
    metadata: { booking_id: String(bookingId), share: 'business' },
  });

  await env.DB.prepare(`UPDATE bookings SET stripe_split_done = 1 WHERE id = ?`).bind(bookingId).run();

  return Response.json({ ok: true, masterCents, businessCents, platformCents });
}
