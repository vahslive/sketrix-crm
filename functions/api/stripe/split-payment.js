// POST /api/stripe/split-payment { bookingId }
// Called right after the app confirms a Tap to Pay charge succeeded.
// Splits the money: the master gets their share, the business gets theirs,
// and Sketrix's cut simply stays on the platform account — it's never
// transferred out, so there's nothing to configure for that part.
//
// Stripe's own processing fee (~2.6% + 10¢ on a tap) is charged to the
// platform balance, and by design it comes out of Sketrix's slice: the
// master and the business are both paid their percentage of the gross.
// On a $250 job that's $100 to the master, $137.50 to the business, and
// $12.50 to Sketrix — of which Stripe takes about $6.60, leaving $5.90.
//
// Idempotent twice over: the booking flag short-circuits a repeat call, and
// each transfer carries a Stripe idempotency key so that even a retry after
// a half-finished split can never pay anyone twice.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';
import { masterPayoutForBooking } from '../../_lib/payout.js';

// Only one business exists today. When a second one arrives, bookings get a
// business_id column and this lookup follows it instead of a hardcoded name.
const BUSINESS_NAME = 'Mount It Right';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }
  const { bookingId } = body;

  const booking = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return Response.json({ ok: false, error: 'Job not found' }, { status: 404 });

  // Moving money on someone else's job is an admin action. A master may only
  // settle the job they personally claimed — the old version let any signed-in
  // user trigger a split for any booking id at all.
  if (user.role !== 'admin' && booking.claimed_by !== user.id) {
    return Response.json({ ok: false, error: 'Not your job' }, { status: 403 });
  }

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
  const business = await env.DB.prepare(`SELECT * FROM businesses WHERE name = ?`).bind(BUSINESS_NAME).first();

  if (!master?.stripe_account_id) {
    return Response.json({ ok: false, error: "This master hasn't finished Stripe payout setup yet." }, { status: 400 });
  }
  if (!business?.stripe_account_id) {
    return Response.json({ ok: false, error: `${BUSINESS_NAME} hasn't finished Stripe payout setup yet.` }, { status: 400 });
  }

  // Pull the charge with its balance transaction so we know the exact fee
  // Stripe took, rather than assuming a rate. Worth recording: it's the
  // difference between Sketrix's headline 5% and what actually lands.
  let feeCents = 0;
  try {
    const charge = await stripeRequest(env, 'GET', `charges/${intent.latest_charge}`, {
      expand: ['balance_transaction'],
    });
    feeCents = charge?.balance_transaction?.fee ?? 0;
  } catch {
    feeCents = 0; // fee is bookkeeping only — never block a payout over it
  }

  const totalCents = intent.amount_received;

  // The master is paid for work, not for parts. Their cut comes from the
  // labour lines of this job — at the higher rate for anything they added on
  // site — so the margin on a bracket the business bought stays with the
  // business. Jobs from before line items existed keep the old flat split.
  const payout = await masterPayoutForBooking(env, booking, business);
  const masterCents = Math.min(payout.masterCents, totalCents);

  // The business takes what is left after the master and the platform, rather
  // than its own percentage of the gross. With parts in the mix those two are
  // no longer the same number, and only one of them can be right: the three
  // shares have to add up to exactly what the customer paid.
  const platformCents = Math.round(totalCents * (100 - business.master_share_percent - business.business_share_percent) / 100);
  const businessCents = totalCents - masterCents - platformCents;
  // The platform's slice has to cover Stripe's fee. If the configured
  // percentages don't leave enough, stop before sending anything rather
  // than transferring one share and failing on the other.
  if (platformCents < feeCents) {
    return Response.json({
      ok: false,
      error: `Payout percentages leave $${(platformCents / 100).toFixed(2)} on the platform but Stripe's fee is $${(feeCents / 100).toFixed(2)}. Fix the shares in the businesses table before splitting this one.`,
    }, { status: 409 });
  }

  await stripeRequest(env, 'POST', 'transfers', {
    amount: masterCents,
    currency: 'usd',
    destination: master.stripe_account_id,
    source_transaction: intent.latest_charge,
    metadata: { booking_id: String(bookingId), share: 'master' },
  }, { idempotencyKey: `split-${bookingId}-master-${intent.id}` });

  await stripeRequest(env, 'POST', 'transfers', {
    amount: businessCents,
    currency: 'usd',
    destination: business.stripe_account_id,
    source_transaction: intent.latest_charge,
    metadata: { booking_id: String(bookingId), share: 'business' },
  }, { idempotencyKey: `split-${bookingId}-business-${intent.id}` });

  // master_earning is what the app and the stats screen show the master they
  // made. It must be what Stripe actually sent them, not a second, separately
  // computed number — those two used to disagree.
  await env.DB.prepare(
    `UPDATE bookings
     SET stripe_split_done = 1,
         stripe_fee_cents = ?,
         master_cents = ?,
         business_cents = ?,
         platform_cents = ?,
         master_earning = ?
     WHERE id = ?`
  ).bind(feeCents, masterCents, businessCents, platformCents, Math.round(masterCents / 100), bookingId).run();

  return Response.json({ ok: true, masterCents, businessCents, platformCents, feeCents });
}
