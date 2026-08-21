// POST /api/auth/change-password  { currentPassword, newPassword }
// Requires the user to confirm their current password before changing it.
import { getUserFromRequest, hashPassword, verifyPassword } from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return Response.json({ ok: false, error: 'Missing current or new password' }, { status: 400 });
  }
  if (newPassword.length < 6) {
    return Response.json({ ok: false, error: 'New password should be at least 6 characters.' }, { status: 400 });
  }

  const fullUser = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(user.id).first();
  if (!fullUser || !(await verifyPassword(currentPassword, fullUser.password_hash))) {
    return Response.json({ ok: false, error: 'Current password is incorrect.' }, { status: 401 });
  }

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(newHash, user.id).run();

  return Response.json({ ok: true });
}
