// GET /api/messages/inbox — admin only. Returns one row per master with
// their most recent message across ANY of their claimed jobs, plus a
// total message count. Masters with zero messages are simply absent here
// — the client merges this with /api/users to still list everyone.
import { getUserFromRequest } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { results } = await env.DB.prepare(`
    SELECT id, master_id, master_name, body, created_at, sender_id, message_count
    FROM (
      SELECT
        m.id AS id,
        u.id AS master_id,
        u.name AS master_name,
        m.body,
        m.created_at,
        m.sender_id,
        COUNT(*) OVER (PARTITION BY u.id) AS message_count,
        ROW_NUMBER() OVER (PARTITION BY u.id ORDER BY m.created_at DESC) AS rn
      FROM users u
      JOIN bookings b ON b.claimed_by = u.id
      JOIN messages m ON m.booking_id = b.id
      WHERE u.role = 'master'
    )
    WHERE rn = 1
    ORDER BY created_at DESC
  `).all();

  return Response.json({ ok: true, threads: results });
}
