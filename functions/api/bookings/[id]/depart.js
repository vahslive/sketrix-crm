// POST /api/bookings/:id/depart  { lat, lng }
// The claiming master hits "Departed" — we take one GPS reading, estimate
// an arrival window, text the client, and mark the job en route.
import { getUserFromRequest } from '../../../_lib/auth.js';
import { sendSms } from '../../../_lib/sms.js';
import { estimateArrivalWindow } from '../../../_lib/eta.js';

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
  const { lat, lng } = body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return Response.json({ ok: false, error: 'Missing location' }, { status: 400 });
  }

  const booking = await env.DB.prepare(
    `SELECT * FROM bookings WHERE id = ? AND claimed_by = ?`
  ).bind(params.id, user.id).first();

  if (!booking) {
    return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });
  }
  if (booking.lat == null || booking.lng == null) {
    return Response.json({ ok: false, error: 'Job has no address coordinates' }, { status: 400 });
  }

  const eta = estimateArrivalWindow(lat, lng, booking.lat, booking.lng);

  await env.DB.prepare(
    `UPDATE bookings SET status = 'en_route', departed_at = datetime('now'), eta_text = ? WHERE id = ?`
  ).bind(eta.text, params.id).run();

  if (booking.phone) {
    await sendSms(env, booking.phone,
      `Mount It Right: ${user.name} is on the way! Estimated arrival ${eta.text}.`
    );
  }

  return Response.json({ ok: true, eta: eta.text, miles: eta.miles });
}
