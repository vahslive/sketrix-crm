// GET /api/reviews — admin only. Every star rating a customer has left, plus
// what they wrote when it wasn't five.
//
// These have been collected since the receipt page went live and have never
// been shown anywhere. A three-star job with "the installer was an hour late"
// written under it is the most valuable sentence in the database, and until
// now it sat unread.
//
// Per-master averages are computed here rather than in the browser so the
// numbers can't drift between the list and the summary.
import { getUserFromRequest } from '../_lib/auth.js';

const MAX_ROWS = 500;

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { results } = await env.DB.prepare(
    `SELECT b.id, b.name, b.phone, b.address, b.booking_date,
            b.rating, b.feedback, b.rated_at, b.completed_at,
            b.total_price, b.actual_total, b.claimed_by,
            u.name AS master_name
     FROM bookings b
     LEFT JOIN users u ON u.id = b.claimed_by
     WHERE b.rating IS NOT NULL
     ORDER BY COALESCE(b.rated_at, b.completed_at, b.booking_date) DESC
     LIMIT ?`
  ).bind(MAX_ROWS).all();

  const reviews = results || [];

  // Denominator for the response rate. Asking 30 customers and hearing back
  // from 6 is a different business from hearing back from 24, and the average
  // star rating alone hides which one you are.
  const completed = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bookings WHERE status = 'completed'`
  ).first();

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) distribution[r.rating] = (distribution[r.rating] || 0) + 1;

  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);

  // Grouped by whoever was on the job. Bookings closed before masters were
  // assigned have no claimed_by and are kept out rather than blamed on anyone.
  const byMaster = new Map();
  for (const r of reviews) {
    if (!r.claimed_by) continue;
    const entry = byMaster.get(r.claimed_by) || {
      id: r.claimed_by, name: r.master_name || 'Unknown', count: 0, sum: 0, low: 0,
    };
    entry.count += 1;
    entry.sum += r.rating;
    if (r.rating < 5) entry.low += 1;
    byMaster.set(r.claimed_by, entry);
  }

  const masters = [...byMaster.values()]
    .map((m) => ({ id: m.id, name: m.name, count: m.count, low: m.low, average: m.sum / m.count }))
    .sort((a, b) => b.average - a.average || b.count - a.count);

  return Response.json({
    ok: true,
    reviews,
    masters,
    summary: {
      count: reviews.length,
      average: reviews.length ? sum / reviews.length : null,
      distribution,
      low: reviews.filter((r) => r.rating < 5).length,
      withComment: reviews.filter((r) => (r.feedback || '').trim()).length,
      completedJobs: completed?.n || 0,
    },
  });
}
