// GET /api/auth/me  ->  { ok, user }  (requires Authorization: Bearer <token>)
import { getUserFromRequest } from '../../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  return Response.json({ ok: true, user });
}
