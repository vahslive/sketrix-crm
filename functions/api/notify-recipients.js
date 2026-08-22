// GET  /api/notify-recipients — admin only, lists all recipients.
// POST /api/notify-recipients { type, value } — admin only, adds one.
import { getUserFromRequest } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, type, value, active FROM notify_recipients ORDER BY type, value`
  ).all();

  return Response.json({ ok: true, recipients: results });
}

export async function onRequestPost({ request, env }) {
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

  const { type, value } = body;
  if (!type || !value || !['sms', 'email'].includes(type)) {
    return Response.json({ ok: false, error: 'type must be sms or email, and value is required' }, { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO notify_recipients (type, value, active) VALUES (?, ?, 1)`
  ).bind(type, value).run();

  return Response.json({ ok: true });
}
