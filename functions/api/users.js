// GET /api/users — list all team members (admin only). Used to populate
// the messages inbox with every master, even ones with no messages yet.
import { getUserFromRequest } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, name, email, phone, role FROM users WHERE active = 1 ORDER BY role, name`
  ).all();

  return Response.json({ ok: true, users: results });
}
