// PATCH  /api/bookings/:id — admin: edit any field (price, status, notes...)
// DELETE /api/bookings/:id — admin: remove a booking
import { getUserFromRequest } from '../../_lib/auth.js';

const EDITABLE_FIELDS = [
  'status', 'booking_date', 'booking_time',
  'name', 'phone', 'address', 'notes', 'total_price', 'actual_total',
  'payment_method',
];

export async function onRequestPatch({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const setClauses = [];
  const values = [];
  for (const key of EDITABLE_FIELDS) {
    if (key in body) {
      setClauses.push(`${key} = ?`);
      values.push(body[key]);
    }
  }
  if (setClauses.length === 0) {
    return Response.json({ ok: false, error: 'No editable fields provided' }, { status: 400 });
  }
  values.push(params.id);

  await env.DB.prepare(
    `UPDATE bookings SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  return Response.json({ ok: true });
}

export async function onRequestDelete({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const booking = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?`)
    .bind(params.id).first();
  if (!booking) {
    return Response.json({ ok: false, error: 'That booking no longer exists.' }, { status: 404 });
  }

  // Other tables point at this booking, and SQLite refuses to delete a row
  // something still references. Deleting the booking on its own therefore
  // failed for any job that had ever been messaged about or signed for —
  // which is most of them — and the failure was invisible.
  //
  // One batch, so a half-deleted booking can't exist: either the chat, the
  // approval and the job all go, or nothing does.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM messages WHERE booking_id = ?`).bind(params.id),
    env.DB.prepare(`DELETE FROM job_authorizations WHERE booking_id = ?`).bind(params.id),
    env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(params.id),
  ]);

  // Chat attachments and signature images stay in R2. They are unreachable
  // without the rows that named them, and a stray key costs a fraction of a
  // cent — cheaper than a delete that half-succeeds.
  return Response.json({ ok: true, deleted: Number(params.id) });
}
