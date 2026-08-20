// POST /api/auth/login  { emailOrPhone, password }  ->  { token, user }
import { verifyPassword, newToken } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { emailOrPhone, password } = body;
  if (!emailOrPhone || !password) {
    return Response.json({ ok: false, error: 'Missing credentials' }, { status: 400 });
  }

  const user = await env.DB.prepare(
    `SELECT * FROM users WHERE (email = ? OR phone = ?) AND active = 1`
  ).bind(emailOrPhone, emailOrPhone).first();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return Response.json({ ok: false, error: 'Invalid email/phone or password' }, { status: 401 });
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`
  ).bind(token, user.id, expiresAt).run();

  return Response.json({
    ok: true,
    token,
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role },
  });
}
