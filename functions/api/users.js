// GET /api/users[?all=1] — list team members (admin only).
//
// By default only active members, because the main caller is the messages
// inbox, which shouldn't show people who no longer have access. Pass ?all=1
// for the Team screen, which needs to show deactivated members so they can be
// switched back on.
import { getUserFromRequest } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const includeInactive = new URL(request.url).searchParams.get('all') === '1';

  const { results } = await env.DB.prepare(
    includeInactive
      ? `SELECT id, name, email, phone, role, active FROM users ORDER BY active DESC, role, name`
      : `SELECT id, name, email, phone, role, active FROM users WHERE active = 1 ORDER BY role, name`
  ).all();

  return Response.json({ ok: true, users: results });
}
