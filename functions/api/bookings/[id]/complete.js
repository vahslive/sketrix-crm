// POST /api/bookings/:id/complete  { paymentMethod, actualTotal? }
// The claiming master marks the job done. Computes their payout, texts the
// client a link to their receipt.
import { getUserFromRequest } from '../../../_lib/auth.js';
import { sendSms } from '../../../_lib/sms.js';

const BUSINESS_NAME = 'Mount It Right';

export async function onRequestPost({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const { paymentMethod = 'cash', actualTotal = null } = body;

  const booking = await env.DB.prepare(
    `SELECT * FROM bookings WHERE id = ? AND claimed_by = ?`
  ).bind(params.id, user.id).first();

  if (!booking) {
    return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });
  }

  const receiptUrl = `${env.SITE_URL || 'https://mountitright.com'}/receipt.html?t=${booking.receipt_token}`;

  // Completing twice is a normal thing to happen — a flaky connection, a
  // tapped button that looked like it did nothing. Don't rewrite the record
  // and don't text the client a second receipt; just report success.
  if (booking.status === 'completed') {
    return Response.json({ ok: true, earning: booking.master_earning, receiptUrl, alreadyCompleted: true });
  }

  // A card payment has already been charged for a specific amount by the
  // time we get here, and create-payment-intent.js wrote that amount to
  // actual_total. The receipt must show what the client's card was actually
  // charged, so that number wins over anything the app sends now.
  const cardCharged = booking.stripe_payment_intent_id && booking.actual_total != null;
  const finalTotal = cardCharged
    ? booking.actual_total
    : (actualTotal != null ? actualTotal : booking.total_price);

  // The master's cut lives in one place: the businesses table. It used to be
  // hardcoded here as 0.30 while the Stripe split used master_share_percent
  // (40), so the payout recorded in the database never matched the money
  // actually transferred. MASTER_COMMISSION_RATE still overrides, if set.
  const business = await env.DB.prepare(`SELECT master_share_percent FROM businesses WHERE name = ?`)
    .bind(BUSINESS_NAME).first();
  const rate = env.MASTER_COMMISSION_RATE
    ? parseFloat(env.MASTER_COMMISSION_RATE)
    : (business?.master_share_percent != null ? business.master_share_percent / 100 : 0.40);

  // If the payout split already ran, it recorded the exact cents Stripe sent
  // the master. That is the truth — prefer it over recomputing from a rate.
  const earning = booking.master_cents != null
    ? Math.round(booking.master_cents / 100)
    : Math.round(finalTotal * rate);

  await env.DB.prepare(
    `UPDATE bookings
     SET status = 'completed', completed_at = datetime('now'),
         payment_method = ?, actual_total = ?, master_earning = ?
     WHERE id = ?`
  ).bind(paymentMethod, finalTotal, earning, params.id).run();

  if (booking.phone && booking.sms_consent) {
    await sendSms(
      env,
      booking.phone,
      `Mount It Right: your installation is complete! Total: $${finalTotal}. Receipt: ${receiptUrl}`,
      { template: 'JOB_COMPLETE', params: { total: finalTotal, receipt: receiptUrl } }
    );
  }

  return Response.json({ ok: true, earning, receiptUrl });
}
