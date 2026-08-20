// POST /api/bookings/:id/claim — a master accepts an unclaimed job.
// Atomic: only succeeds if the job is still 'new' and unclaimed, so two
// masters tapping "Accept" at the same moment can't both win it.
import { getUserFromRequest } from '../../../_lib/auth.js';

export async function onRequestPost({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const result = await env.DB.prepare(
    `UPDATE bookings
     SET status = 'claimed', claimed_by = ?, claimed_at = datetime('now')
     WHERE id = ? AND status = 'new' AND claimed_by IS NULL`
  ).bind(user.id, params.id).run();

  if (result.meta.changes === 0) {
    return Response.json({ ok: false, error: 'Already claimed by someone else' }, { status: 409 });
  }

  return Response.json({ ok: true });
}
