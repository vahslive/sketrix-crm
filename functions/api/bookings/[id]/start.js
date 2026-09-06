// POST /api/bookings/:id/start — the claiming master hits "Start job" once
// they've actually arrived and begin working. This doesn't change status
// (stays 'en_route') — it just timestamps the start of hands-on-tools time,
// so completed_at - started_at gives a real duration for the job.
//
// It is also the gate for the signed work authorization. "Start job" is the
// last moment before the first hole goes into someone's wall, so it is the
// right place to insist the customer has approved it — and the server has to
// be the one insisting. A check that lives only in the app is a check that
// disappears the first time someone installs an older build.
import { getUserFromRequest } from '../../../_lib/auth.js';

export async function onRequestPost({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const booking = await env.DB.prepare(
    `SELECT * FROM bookings WHERE id = ? AND claimed_by = ?`
  ).bind(params.id, user.id).first();

  if (!booking) {
    return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });
  }

  const auth = await env.DB.prepare(
    `SELECT status FROM job_authorizations WHERE booking_id = ?`
  ).bind(params.id).first();

  if (!auth || auth.status !== 'signed') {
    return Response.json({
      ok: false,
      needsAuthorization: true,
      error: 'This job needs the customer\'s approval before work can start.',
    }, { status: 400 });
  }

  await env.DB.prepare(
    `UPDATE bookings SET started_at = datetime('now') WHERE id = ?`
  ).bind(params.id).run();

  return Response.json({ ok: true, started_at: new Date().toISOString() });
}
