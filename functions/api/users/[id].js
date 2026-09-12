// PATCH /api/users/:id { active }  — admin only.
// Deactivates or reactivates a team member.
//
// There is no delete, deliberately. Every completed job points at the master
// who did it, and every chat message at whoever wrote it. Removing the row
// would leave that history pointing at nothing — jobs with no technician,
// messages with no author, payout totals that no longer add up. Deactivating
// keeps the record intact and takes away the access, which is what "remove
// someone from the team" actually means in practice.
import { getUserFromRequest } from '../../_lib/auth.js';

export async function onRequestPatch({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const changingActive = typeof body.active === 'boolean';
  const changingDisplayName = 'displayName' in body;

  if (!changingActive && !changingDisplayName) {
    return Response.json(
      { ok: false, error: 'Send { active: true | false } or { displayName: "..." }' },
      { status: 400 }
    );
  }

  const targetId = Number(params.id);
  const target = await env.DB.prepare(`SELECT id, name, role, active FROM users WHERE id = ?`)
    .bind(targetId).first();
  if (!target) return Response.json({ ok: false, error: 'User not found' }, { status: 404 });

  // The name customers see, which is not always the name on the paperwork.
  // "Andrii Vakhmianin is on the way" is correct and unhelpful; "Andy is on
  // the way" is what the person at the door is expecting. Only this one is
  // ever shown outside the company — everything internal keeps the real name,
  // so payouts, 1099s and job history stay attached to a real person.
  if (changingDisplayName) {
    const raw = body.displayName;
    if (raw !== null && typeof raw !== 'string') {
      return Response.json({ ok: false, error: 'A display name has to be text.' }, { status: 400 });
    }
    const displayName = (raw || '').trim().slice(0, 40);
    if (displayName && displayName.length < 2) {
      return Response.json({ ok: false, error: 'A display name needs at least two characters.' }, { status: 400 });
    }
    // Empty clears it, and customers see the real name again.
    await env.DB.prepare(`UPDATE users SET display_name = ? WHERE id = ?`)
      .bind(displayName || null, targetId).run();
  }

  if (!changingActive) {
    return Response.json({ ok: true, displayName: (body.displayName || '').trim() || null });
  }

  // Locking yourself out is a one-way door: an inactive user can't sign in, so
  // they can't undo it either.
  if (targetId === user.id && body.active === false) {
    return Response.json({ ok: false, error: "You can't deactivate your own account." }, { status: 400 });
  }

  // Nor can the last admin standing be switched off — that leaves the whole
  // system with nobody able to administer it.
  if (target.role === 'admin' && body.active === false) {
    const { count } = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1`
    ).first();
    if (count <= 1) {
      return Response.json({ ok: false, error: 'This is the last active admin — promote someone else first.' }, { status: 400 });
    }
  }

  await env.DB.prepare(`UPDATE users SET active = ? WHERE id = ?`)
    .bind(body.active ? 1 : 0, targetId).run();

  // Someone who no longer has access shouldn't keep getting job alerts on
  // their phone. Their tokens go; if they're ever reactivated, the app
  // registers a fresh one the next time they sign in.
  if (body.active === false) {
    await env.DB.prepare(`DELETE FROM device_tokens WHERE user_id = ?`).bind(targetId).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(targetId).run();
  }

  return Response.json({ ok: true, id: targetId, active: body.active });
}
