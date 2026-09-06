// GET  /api/bookings/:id/authorization  — has this job been authorised yet?
// POST /api/bookings/:id/authorization { send? } — create the authorization and,
//      optionally, text or email the customer a link to sign it themselves.
//
// Two ways to the same signature. Standing next to the customer, the master
// hands over the phone and they sign there. When nobody is home — the key was
// left out, the tenant is at work — the master sends a link, the customer signs
// on their own phone, and the app unlocks the moment it lands.
import { getUserFromRequest } from '../../../_lib/auth.js';
import { sendSms } from '../../../_lib/sms.js';
import { activeAgreement } from '../../../_lib/agreement.js';

const DEFAULT_SITE_URL = 'https://sketrix.com';

function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The master on the job, or any admin. */
async function loadBookingFor(env, user, bookingId) {
  const booking = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return null;
  if (user.role !== 'admin' && booking.claimed_by !== user.id) return null;
  return booking;
}

export async function onRequestGet({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const booking = await loadBookingFor(env, user, params.id);
  if (!booking) return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });

  const auth = await env.DB.prepare(`SELECT * FROM job_authorizations WHERE booking_id = ?`)
    .bind(params.id).first();

  if (!auth) return Response.json({ ok: true, exists: false, signed: false });

  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  return Response.json({
    ok: true,
    exists: true,
    signed: auth.status === 'signed',
    // The token goes to the app so it can read the acknowledgement wording
    // from /api/sign/:token — the same text the customer sees on the web page.
    // Two copies of that wording would drift, and a signature is only worth
    // something next to the exact words it was given for.
    token: auth.token,
    signUrl: `${siteUrl}/sign.html?t=${auth.token}`,
    customerName: auth.customer_name,
    propertyStatus: auth.property_status,
    signatureUrl: auth.signature_url,
    signedAt: auth.signed_at,
    signedVia: auth.signed_via,
    // Which wording was actually on screen. Without it a stored signature only
    // proves someone signed something — the admin links this straight to
    // /install-terms.html?v=… so the exact text can be reread years later.
    agreementVersion: auth.agreement_version,
  });
}

export async function onRequestPost({ request, env, params }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const booking = await loadBookingFor(env, user, params.id);
  if (!booking) return Response.json({ ok: false, error: 'Job not found or not yours' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const send = body.send === true || body.send === 'sms'; // text the customer the link

  let auth = await env.DB.prepare(`SELECT * FROM job_authorizations WHERE booking_id = ?`)
    .bind(params.id).first();

  if (!auth) {
    const token = newToken();
    const agreement = await activeAgreement(env);
    await env.DB.prepare(
      `INSERT INTO job_authorizations (booking_id, token, agreement_version, quoted_total, created_by)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(params.id, token, agreement.version, booking.actual_total ?? booking.total_price, user.id).run();
    auth = await env.DB.prepare(`SELECT * FROM job_authorizations WHERE booking_id = ?`)
      .bind(params.id).first();
  }

  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;
  const signUrl = `${siteUrl}/sign.html?t=${auth.token}`;

  // Delivery is best-effort and the URL comes back either way. A text can sit
  // in a carrier queue for hours and an email can bounce; when that happens the
  // master should be able to read the link off the screen and send it by hand
  // rather than being stuck at the customer's door.
  // Bookings carry a phone but no email address, so the link goes out by text.
  if (auth.status !== 'signed' && send && booking.phone) {
    await sendSms(
      env,
      booking.phone,
      `Mount It Right: please approve the work at your property before we start: ${signUrl}`,
      { template: 'SIGN_REQUEST', params: { link: signUrl } }
    );
  }

  return Response.json({
    ok: true,
    signed: auth.status === 'signed',
    token: auth.token,
    signUrl,
  });
}
