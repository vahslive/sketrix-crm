// GET  /api/agreement            — admin: the active wording plus every past version
// POST /api/agreement { ... }    — admin: save the edits as a NEW version
//
// There is no update in place, deliberately. Every signature in
// job_authorizations records the version it was taken under, and that is the
// whole basis for saying later "this is what the customer read." Editing a row
// that past signatures point at would rewrite history — so an edit always
// becomes a new version, and the old text stays untouched and still readable.
import { getUserFromRequest } from '../_lib/auth.js';
import { activeAgreement } from '../_lib/agreement.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const current = await activeAgreement(env);

  // How many signatures each version carries. An admin about to change the
  // wording should be able to see that 40 people signed the current one.
  let versions = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT v.id, v.version, v.active, v.created_at,
              (SELECT COUNT(*) FROM job_authorizations a
                WHERE a.agreement_version = v.version AND a.status = 'signed') AS signatures
       FROM agreement_versions v
       ORDER BY v.id DESC`
    ).all();
    versions = results;
  } catch {
    versions = [];
  }

  return Response.json({ ok: true, current, versions });
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

  const summary = String(body.summary || '').trim();
  const fullText = String(body.fullText || '').trim();
  const acks = Array.isArray(body.acknowledgements) ? body.acknowledgements : [];

  if (summary.length < 20) {
    return Response.json({ ok: false, error: 'The summary is too short to mean anything.' }, { status: 400 });
  }
  if (fullText.length < 200) {
    return Response.json({ ok: false, error: 'The full terms look truncated — nothing saved.' }, { status: 400 });
  }

  // Ids are assigned here rather than typed by hand. They only need to be
  // stable within a version, and generating them removes a whole category of
  // mistake: a duplicate id would silently make one tick box satisfy two.
  const cleaned = acks
    .map((a) => String(typeof a === 'string' ? a : a?.text || '').trim())
    .filter((t) => t.length > 10)
    .map((text, i) => ({ id: `a${i + 1}`, text }));

  if (!cleaned.length) {
    return Response.json({ ok: false, error: 'Keep at least one point for the customer to confirm.' }, { status: 400 });
  }

  // Version labels are the date, with a counter when the wording is revised
  // more than once in a day — readable at a glance, and unique.
  const today = new Date().toISOString().slice(0, 10);
  const { results: sameDay } = await env.DB.prepare(
    `SELECT version FROM agreement_versions WHERE version LIKE ?`
  ).bind(`${today}%`).all();
  const version = sameDay.length ? `${today}-${sameDay.length + 1}` : today;

  await env.DB.prepare(`UPDATE agreement_versions SET active = 0`).run();
  await env.DB.prepare(
    `INSERT INTO agreement_versions (version, summary, acknowledgements_json, full_text, active, created_by)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).bind(version, summary, JSON.stringify(cleaned), fullText, user.id).run();

  return Response.json({ ok: true, version });
}
