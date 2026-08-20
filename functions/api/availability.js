// GET /api/availability — public. Returns taken slots per day so the site's
// calendar can show real availability instead of mock data.

export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    `SELECT booking_date, booking_time FROM bookings
     WHERE status != 'cancelled'
       AND booking_date IS NOT NULL
       AND booking_date >= date('now')`
  ).all();

  const taken = {};
  for (const row of results) {
    if (!taken[row.booking_date]) taken[row.booking_date] = [];
    if (row.booking_time) taken[row.booking_date].push(row.booking_time);
  }

  return Response.json({ ok: true, taken });
}
