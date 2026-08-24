// GET /api/receipt/:token — public, no auth. Looked up by the random
// receipt_token (not the booking id), so it can't be guessed/enumerated.
export async function onRequestGet({ env, params }) {
  const booking = await env.DB.prepare(
    `SELECT b.id, b.name, b.address, b.dismount, b.size, b.bracket, b.wall, b.wires, b.addons, b.tvs_json,
            b.total_price, b.actual_total, b.payment_method, b.completed_at, b.booking_date, b.booking_time,
            u.name AS master_name
     FROM bookings b
     LEFT JOIN users u ON u.id = b.claimed_by
     WHERE b.receipt_token = ?`
  ).bind(params.token).first();

  if (!booking) {
    return Response.json({ ok: false, error: 'Receipt not found' }, { status: 404 });
  }

  return Response.json({ ok: true, receipt: booking });
}
