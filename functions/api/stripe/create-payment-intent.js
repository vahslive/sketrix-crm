// POST /api/stripe/create-payment-intent { bookingId }
// Creates a PaymentIntent on the platform (Sketrix) account, configured
// for Tap to Pay. statement_descriptor makes sure the client's bank
// statement shows "MOUNT IT RIGHT" — a name they actually recognize —
// instead of "SKETRIX", which they've never heard of and could dispute.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }
  const { bookingId } = body;

  const booking = await env.DB.prepare(
    `SELECT * FROM bookings WHERE id = ? AND claimed_by = ?`
  ).bind(bookingId, user.id).first();
  if (!booking) return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });

  const amount = booking.actual_total ?? booking.total_price;
  if (!amount || amount <= 0) return Response.json({ ok: false, error: 'Invalid amount' }, { status: 400 });

  const intent = await stripeRequest(env, 'POST', 'payment_intents', {
    amount: Math.round(amount * 100), // Stripe wants cents
    currency: 'usd',
    payment_method_types: ['card_present'],
    capture_method: 'automatic',
    statement_descriptor: 'MOUNT IT RIGHT', // max 22 chars — this fits with room to spare
    metadata: { booking_id: String(bookingId) },
  });

  await env.DB.prepare(`UPDATE bookings SET stripe_payment_intent_id = ? WHERE id = ?`)
    .bind(intent.id, bookingId).run();

  return Response.json({ ok: true, clientSecret: intent.client_secret, paymentIntentId: intent.id });
}
