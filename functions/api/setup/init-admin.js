// POST /api/setup/init-admin  { name, email, phone, password }
// Creates the very first admin account. Only works while the users table
// is completely empty — call it once, then it's permanently disabled.
import { hashPassword } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const { results } = await env.DB.prepare(`SELECT COUNT(*) as n FROM users`).all();
  if (results[0].n > 0) {
    return Response.json({ ok: false, error: 'Setup already completed — an account already exists.' }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const { name, email, phone, password } = body;
  if (!name || !password || (!email && !phone)) {
    return Response.json({ ok: false, error: 'Need name, password, and email or phone' }, { status: 400 });
  }

  const hash = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`
  ).bind(name, email || null, phone || null, hash).run();

  return Response.json({ ok: true, message: 'Admin account created. You can now log in.' });
}
