// POST /api/sign/:token/submit — public, no auth.
// { customerName, propertyStatus, acknowledgements: {id: true, ...}, signature }
//
// `signature` is a PNG data URL drawn on the customer's screen. Same endpoint
// whether they signed on the installer's phone at the door or on their own
// phone from a link — the only difference recorded is signed_via.
import { activeAgreement } from '../../../_lib/agreement.js';

// A drawn signature is a few tens of kilobytes. Anything approaching this is
// not a signature.
const MAX_SIGNATURE_BYTES = 800 * 1024;

const R2_PUBLIC_BASE = 'https://pub-3fa5ac77537b4c63a8a0fcf1f561b596.r2.dev';

function randomKey() {
  const rand = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return `signature-${rand}.png`;
}

function decodeDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) return null;
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function onRequestPost({ request, env, params }) {
  const auth = await env.DB.prepare(`SELECT * FROM job_authorizations WHERE token = ?`)
    .bind(params.token).first();
  if (!auth) return Response.json({ ok: false, error: 'This link is not valid.' }, { status: 404 });

  // Signing twice would overwrite the first signature with a second one taken
  // under who-knows-what circumstances. The first one stands.
  if (auth.status === 'signed') {
    return Response.json({ ok: true, alreadySigned: true });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const customerName = String(body.customerName || '').trim();
  const propertyStatus = body.propertyStatus;
  const acks = body.acknowledgements || {};

  if (customerName.length < 2) {
    return Response.json({ ok: false, error: 'Please enter your full name.' }, { status: 400 });
  }
  if (propertyStatus !== 'owner' && propertyStatus !== 'tenant') {
    return Response.json({ ok: false, error: 'Please tell us whether you own or rent this property.' }, { status: 400 });
  }

  // Every acknowledgement has to be ticked, checked against the wording that
  // is live at this moment. Doing it server-side and not only in the page
  // means a signature in the database always corresponds to someone who
  // confirmed all of them, for the version recorded beside it.
  const agreement = await activeAgreement(env);
  const missing = agreement.acknowledgements.filter((a) => acks[a.id] !== true);
  if (missing.length) {
    return Response.json({ ok: false, error: 'Please confirm every point before signing.' }, { status: 400 });
  }

  const bytes = decodeDataUrl(body.signature);
  if (!bytes) {
    return Response.json({ ok: false, error: 'Please sign in the box above.' }, { status: 400 });
  }
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    return Response.json({ ok: false, error: 'Signature image is too large.' }, { status: 400 });
  }

  const key = randomKey();
  await env.CHAT_FILES.put(key, bytes.buffer, {
    httpMetadata: { contentType: 'image/png' },
  });

  await env.DB.prepare(
    `UPDATE job_authorizations
     SET status = 'signed', customer_name = ?, property_status = ?, signature_url = ?,
         signed_via = ?, signed_at = datetime('now'), signed_ip = ?, signed_user_agent = ?,
         agreement_version = ?
     WHERE token = ?`
  ).bind(
    customerName,
    propertyStatus,
    `${R2_PUBLIC_BASE}/${key}`,
    body.onSite === true ? 'on_site' : 'remote',
    request.headers.get('CF-Connecting-IP') || null,
    (request.headers.get('User-Agent') || '').slice(0, 400),
    agreement.version,
    params.token
  ).run();

  return Response.json({ ok: true, signed: true });
}
