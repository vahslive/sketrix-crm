// POST /api/invites  { name, email, phone, role } — admin creates an invite,
//                      sends the link by SMS and/or email.
// GET  /api/invites  — admin lists pending (unused) invites.
import { getUserFromRequest } from '../_lib/auth.js';
import { sendSms } from '../_lib/sms.js';
import { sendEmail } from '../_lib/email.js';

function newInviteToken() {
  return [...crypto.getRandomValues(new Uint8Array(20))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost({ request, env }) {
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
  const { name, email = null, phone = null, role = 'master' } = body;
  if (!name || (!email && !phone) || !['admin', 'master'].includes(role)) {
    return Response.json({ ok: false, error: 'Need name, email or phone, and a valid role' }, { status: 400 });
  }

  const token = newInviteToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO invites (token, name, email, phone, role, created_by, expires_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(token, name, email, phone, role, user.id, expiresAt).run();

  const link = `${env.SITE_URL || 'https://mountitright.com'}/accept-invite.html?token=${token}`;
  const roleLabel = role === 'admin' ? 'an admin' : 'a master';
  const message = `${user.name} invited you to Mount It Right as ${roleLabel}. Set up your account: ${link}`;

  if (phone) {
    await sendSms(env, phone, message, {
      template: 'TEAM_INVITE',
      params: { inviter: user.name, role: roleLabel, link },
    });
  }
  if (email) await sendEmail(env, email, `You're invited to Mount It Right`, message);

  return Response.json({ ok: true, link });
}

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { results } = await env.DB.prepare(
    `SELECT id, name, email, phone, role, created_at, expires_at
     FROM invites WHERE used = 0 AND expires_at > datetime('now')
     ORDER BY created_at DESC`
  ).all();

  return Response.json({ ok: true, invites: results });
}
