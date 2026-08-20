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
  await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(params.id).run();
  return Response.json({ ok: true });
}
