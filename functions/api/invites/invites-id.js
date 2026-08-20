// DELETE /api/invites/:id — admin revokes a pending invite.
import { getUserFromRequest } from '../../_lib/auth.js';

export async function onRequestDelete({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  await env.DB.prepare(`DELETE FROM invites WHERE id = ?`).bind(params.id).run();
  return Response.json({ ok: true });
}
