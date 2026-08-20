// POST /api/invites/accept  { token, password }
// Public — validates the invite token, creates the account, and returns a
// session token so the person is immediately logged in.
import { hashPassword, newToken } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const { token, password } = body;
  if (!token || !password) {
    return Response.json({ ok: false, error: 'Missing token or password' }, { status: 400 });
  }

  const invite = await env.DB.prepare(
    `SELECT * FROM invites WHERE token = ? AND used = 0 AND expires_at > datetime('now')`
  ).bind(token).first();

  if (!invite) {
    return Response.json({ ok: false, error: 'This invite is invalid or has expired.' }, { status: 404 });
  }

  const passwordHash = await hashPassword(password);
  const result = await env.DB.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role) VALUES (?,?,?,?,?)`
  ).bind(invite.name, invite.email, invite.phone, passwordHash, invite.role).run();

  await env.DB.prepare(`UPDATE invites SET used = 1 WHERE id = ?`).bind(invite.id).run();

  const sessionToken = newToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  ).bind(sessionToken, result.meta.last_row_id, expiresAt).run();

  return Response.json({
    ok: true,
    token: sessionToken,
    user: { id: result.meta.last_row_id, name: invite.name, email: invite.email, phone: invite.phone, role: invite.role },
  });
}
