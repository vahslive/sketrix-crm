// POST   /api/devices { token, platform? } — register this phone for pushes
// DELETE /api/devices { token }            — unregister it (called on logout)
//
// The app calls POST every time it starts with a valid session, not just once.
// APNs tokens change — after a restore from backup, a reinstall, sometimes an
// OS update — and a stale token silently stops delivering. Re-registering on
// every launch costs one tiny request and removes that whole class of "why did
// my notifications stop" problem.
import { getUserFromRequest } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { token, platform = 'ios' } = body;
  if (!token || typeof token !== 'string') {
    return Response.json({ ok: false, error: 'Missing device token' }, { status: 400 });
  }

  // The token is the primary key, so this both registers a new device and
  // moves an existing one to whoever is signed in now — which is what should
  // happen when a phone changes hands between technicians.
  await env.DB.prepare(
    `INSERT INTO device_tokens (token, user_id, platform)
     VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       user_id = excluded.user_id,
       platform = excluded.platform,
       updated_at = datetime('now')`
  ).bind(token, user.id, platform).run();

  return Response.json({ ok: true });
}

export async function onRequestDelete({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { token } = body;
  if (!token) return Response.json({ ok: false, error: 'Missing device token' }, { status: 400 });

  // Scoped to this user on purpose: signing out must never let someone
  // silence notifications on somebody else's phone.
  await env.DB.prepare(`DELETE FROM device_tokens WHERE token = ? AND user_id = ?`)
    .bind(token, user.id).run();

  return Response.json({ ok: true });
}
