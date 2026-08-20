// POST /api/bookings/:id/complete  { paymentMethod, actualTotal? }
// The claiming master marks the job done. Computes their payout, texts the
// client a link to their receipt.
import { getUserFromRequest } from '../../../_lib/auth.js';
import { sendSms } from '../../../_lib/sms.js';

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

  const finalTotal = actualTotal != null ? actualTotal : booking.total_price;
  // Default master commission is 65% — override per-deployment with the
  // MASTER_COMMISSION_RATE environment variable (e.g. "0.4") if needed.
  const rate = env.MASTER_COMMISSION_RATE ? parseFloat(env.MASTER_COMMISSION_RATE) : 0.30;
  const earning = Math.round(finalTotal * rate);

  await env.DB.prepare(
    `UPDATE bookings
     SET status = 'completed', completed_at = datetime('now'),
         payment_method = ?, actual_total = ?, master_earning = ?
     WHERE id = ?`
  ).bind(paymentMethod, finalTotal, earning, params.id).run();

  const receiptUrl = `${env.SITE_URL || 'https://mountitright.com'}/receipt.html?t=${booking.receipt_token}`;

  if (booking.phone) {
    await sendSms(env, booking.phone,
      `Mount It Right: your installation is complete! Total: $${finalTotal}. Receipt: ${receiptUrl}`
    );
  }

  return Response.json({ ok: true, earning, receiptUrl });
}
