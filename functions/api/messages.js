// GET  /api/messages?booking_id=X — list messages for a booking (auth required)
// POST /api/messages { bookingId, body } — post a message (auth required)
import { getUserFromRequest } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const bookingId = url.searchParams.get('booking_id');
  if (!bookingId) return Response.json({ ok: false, error: 'Missing booking_id' }, { status: 400 });

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.body, m.created_at, m.sender_id, u.name as sender_name, u.role as sender_role
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.booking_id = ? ORDER BY m.created_at ASC`
  ).bind(bookingId).all();

  return Response.json({ ok: true, messages: results });
}

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const { bookingId, body: text } = body;
  if (!bookingId || !text) {
    return Response.json({ ok: false, error: 'Missing bookingId or body' }, { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO messages (booking_id, sender_id, body) VALUES (?, ?, ?)`
  ).bind(bookingId, user.id, text).run();

  return Response.json({ ok: true });
}
