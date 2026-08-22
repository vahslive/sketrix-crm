// GET /api/messages/by-master?master_id=X — admin only. Returns every
// message across every job that master has ever claimed, chronologically,
// each tagged with which booking it belongs to (so the combined thread
// still shows which job a message was about).
import { getUserFromRequest } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const masterId = url.searchParams.get('master_id');
  if (!masterId) return Response.json({ ok: false, error: 'Missing master_id' }, { status: 400 });

  const { results } = await env.DB.prepare(`
    SELECT
      m.id, m.body, m.created_at, m.sender_id,
      u.name AS sender_name, u.role AS sender_role,
      m.attachment_url, m.attachment_type, m.attachment_name,
      b.id AS booking_id, b.address AS booking_address,
      b.status AS booking_status, b.booking_date
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    JOIN bookings b ON b.id = m.booking_id
    WHERE b.claimed_by = ?
    ORDER BY m.created_at ASC
  `).bind(masterId).all();

  return Response.json({ ok: true, messages: results });
}
