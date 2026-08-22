// GET  /api/messages?booking_id=X — list messages for a booking (auth required)
// POST /api/messages { bookingId, body?, attachmentUrl?, attachmentType?, attachmentName? }
import { getUserFromRequest } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const bookingId = url.searchParams.get('booking_id');
  if (!bookingId) return Response.json({ ok: false, error: 'Missing booking_id' }, { status: 400 });

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.body, m.created_at, m.sender_id, u.name as sender_name, u.role as sender_role,
            m.attachment_url, m.attachment_type, m.attachment_name
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
  const { bookingId, body: text, attachmentUrl, attachmentType, attachmentName } = body;
  if (!bookingId || (!text && !attachmentUrl)) {
    return Response.json({ ok: false, error: 'Message needs text, an attachment, or both.' }, { status: 400 });
  }

  const result = await env.DB.prepare(
    `INSERT INTO messages (booking_id, sender_id, body, attachment_url, attachment_type, attachment_name)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(bookingId, user.id, text || '', attachmentUrl || null, attachmentType || null, attachmentName || null).run();

  // Push the new message to anyone with this master's chat room open right
  // now (admin's Messages inbox, or that master's own app). If this fails
  // for any reason, the message is still safely saved — realtime is a nice
  // extra, never a requirement for the message to exist.
  try {
    const row = await env.DB.prepare(
      `SELECT m.id, m.body, m.created_at, m.sender_id, u.name as sender_name, u.role as sender_role,
              m.attachment_url, m.attachment_type, m.attachment_name,
              b.id as booking_id, b.address as booking_address, b.status as booking_status,
              b.booking_date, b.claimed_by
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       JOIN bookings b ON b.id = m.booking_id
       WHERE m.id = ?`
    ).bind(result.meta.last_row_id).first();

    if (row && row.claimed_by) {
      const id = env.CHAT_ROOM.idFromName(`master:${row.claimed_by}`);
      const room = env.CHAT_ROOM.get(id);
      await room.fetch('https://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify({ type: 'new_message', message: row }),
      });
    }
  } catch (err) {
    console.error('Realtime broadcast failed (message was still saved):', err);
  }

  return Response.json({ ok: true });
}
