// GET /api/receipt/:token — public, no auth. Looked up by the random
// receipt_token (not the booking id), so it can't be guessed/enumerated.
export async function onRequestGet({ env, params }) {
  const booking = await env.DB.prepare(
    `SELECT id, name, address, dismount, size, bracket, wall, wires, addons,
            total_price, actual_total, payment_method, completed_at, booking_date, booking_time
     FROM bookings WHERE receipt_token = ?`
  ).bind(params.token).first();

  if (!booking) {
    return Response.json({ ok: false, error: 'Receipt not found' }, { status: 404 });
  }

  return Response.json({ ok: true, receipt: booking });
}
