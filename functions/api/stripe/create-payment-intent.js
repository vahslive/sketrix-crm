// POST /api/stripe/create-payment-intent { bookingId, amount }
// Creates (or reuses) a PaymentIntent on the platform (Sketrix) account,
// configured for Tap to Pay.
//
// `amount` is the final price in whole dollars, as typed by the master on
// the "mark complete" sheet. It is REQUIRED and it is what actually gets
// charged. The old version of this endpoint ignored the app entirely and
// charged `actual_total ?? total_price` — but actual_total is only written
// when the job is completed, which happens AFTER the tap. So whenever a
// master adjusted the price on site, the card was charged the original
// quoted price while the app and the receipt both showed the new one.
//
// We now write actual_total here, before the charge, so the amount on the
// card, the amount in the database and the amount on the receipt can never
// drift apart.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

// Fat-finger guard: an extra zero turns a $250 job into $2,500 on someone's
// real card. Override per-deployment with MAX_CARD_AMOUNT if you ever need
// to take a bigger payment than this.
const DEFAULT_MAX_AMOUNT = 5000;

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }
  const { bookingId, amount } = body;

  const booking = await env.DB.prepare(
    `SELECT * FROM bookings WHERE id = ? AND claimed_by = ?`
  ).bind(bookingId, user.id).first();
  if (!booking) return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });

  // Fall back to the quoted price only if the app sent nothing at all, so an
  // older build of the app keeps working instead of failing outright.
  const requested = amount == null ? booking.total_price : amount;
  const finalAmount = Number(requested);

  if (!Number.isInteger(finalAmount) || finalAmount <= 0) {
    return Response.json({ ok: false, error: 'Invalid amount' }, { status: 400 });
  }

  const maxAmount = Number(env.MAX_CARD_AMOUNT) || DEFAULT_MAX_AMOUNT;
  if (finalAmount > maxAmount) {
    return Response.json(
      { ok: false, error: `That's above the $${maxAmount} card limit — double-check the price, or take this one another way.` },
      { status: 400 }
    );
  }

  const amountInCents = finalAmount * 100;

  // If this job already has an intent, decide what to do with it rather
  // than blindly making a new one. Creating a fresh intent every time is
  // how you end up charging a client twice: the tap succeeds, something
  // downstream fails, the master hits "try again", and a brand-new intent
  // takes a second payment while the first one is still sitting there paid.
  if (booking.stripe_payment_intent_id) {
    let existing = null;
    try {
      existing = await stripeRequest(env, 'GET', `payment_intents/${booking.stripe_payment_intent_id}`);
    } catch {
      existing = null; // intent vanished (wrong key, wrong mode) — fall through and make a new one
    }

    if (existing) {
      if (existing.status === 'succeeded') {
        // Already paid. Tell the app so it can go straight to the payout
        // split instead of collecting a second tap.
        return Response.json({
          ok: true,
          alreadyPaid: true,
          paymentIntentId: existing.id,
          amount: Math.round((existing.amount_received || existing.amount) / 100),
        });
      }

      if (existing.status === 'processing' || existing.status === 'requires_capture') {
        return Response.json(
          { ok: false, error: 'A payment for this job is still going through — give it a moment before trying again.' },
          { status: 409 }
        );
      }

      // Anything still open (requires_payment_method / requires_confirmation)
      // gets reused, with the amount corrected if the master changed it.
      if (existing.status !== 'canceled') {
        const reusable = existing.amount === amountInCents
          ? existing
          : await stripeRequest(env, 'POST', `payment_intents/${existing.id}`, { amount: amountInCents });

        await env.DB.prepare(`UPDATE bookings SET actual_total = ? WHERE id = ?`)
          .bind(finalAmount, bookingId).run();

        return Response.json({ ok: true, clientSecret: reusable.client_secret, paymentIntentId: reusable.id });
      }
    }
  }

  const intent = await stripeRequest(env, 'POST', 'payment_intents', {
    amount: amountInCents,
    currency: 'usd',
    payment_method_types: ['card_present'],
    capture_method: 'automatic',
    statement_descriptor: 'MOUNT IT RIGHT', // max 22 chars — this fits with room to spare
    metadata: { booking_id: String(bookingId), master_id: String(user.id) },
  });

  await env.DB.prepare(`UPDATE bookings SET stripe_payment_intent_id = ?, actual_total = ? WHERE id = ?`)
    .bind(intent.id, finalAmount, bookingId).run();

  return Response.json({ ok: true, clientSecret: intent.client_secret, paymentIntentId: intent.id });
}
