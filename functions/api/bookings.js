// POST /api/bookings — create a booking (public site, or admin/phone entry)
// GET  /api/bookings — list bookings (auth required; admin sees all, master
//                       sees unclaimed jobs plus their own claimed jobs)
import { getUserFromRequest } from '../_lib/auth.js';
import { sendSms, sendSmsToMany } from '../_lib/sms.js';
import { sendEmail } from '../_lib/email.js';
import { sendPushToUsers, activeStaffIds } from '../_lib/push.js';
import { loadPrices, additionalTvDiscount, computeTotal } from '../_lib/pricing.js';

function newReceiptToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A trimmed string, or null — never an empty string, which reads as data. */
function clip(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

/**
 * Serialises a plain object for storage, refusing anything larger than the
 * cap. Oversized attribution is a sign of something wrong rather than a very
 * enthusiastic campaign name, and it is not worth a row in the database.
 */
function jsonOrNull(value, maxChars) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const text = JSON.stringify(value);
    return text.length > maxChars ? null : text;
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const user = await getUserFromRequest(request, env);
  const admin = user && user.role === 'admin';

  // Two different things have historically been called "source", and they must
  // not be confused:
  //
  //   source      — how the booking reached us: online, phone, typed by hand.
  //   lead_source — where the customer came from: facebook, google, direct.
  //
  // An admin filling the form in the panel means the first; the booking form
  // on the website means the second, because that is what its `source` field
  // has always carried. Which one arrived is decided by who is signed in.
  const source = admin && body.source ? body.source : 'online';
  const leadSource = admin
    ? clip(body.leadSource, 60)
    : clip(body.source, 60);

  // Attribution and the pixel identifiers are stored as sent, because their
  // only consumers are a report and the Conversions API. Capped, since this is
  // an unauthenticated endpoint and nothing else limits what arrives here.
  const attributionJson = jsonOrNull(body.attribution, 4000);
  const metaJson = jsonOrNull(body.meta, 2000);

  const {
    address = null, lat = null, lng = null, inServiceArea = null,
    dismount = null, size = null, bracket = null, wall = null, wires = null,
    addons = [], total = 0, date = null, time = null,
    name = null, phone = null, notes = null, tvs = null, smsConsent = false,
  } = body;

  // The price is worked out here, from the price list in the database — not
  // taken from whatever number the page sent. The booking form runs the same
  // rules client-side so the customer sees the figure before submitting, but a
  // total that arrives over the wire is a total anyone can edit, and this is
  // the only copy that reaches a card.
  //
  // Admin-entered bookings are the exception: a job taken over the phone can
  // be priced by hand for reasons no price list knows about, and whoever typed
  // it is signed in as an admin.
  let finalTotal = Number(total) || 0;
  if (Array.isArray(tvs) && tvs.length) {
    try {
      const { byCode } = await loadPrices(env);
      const discount = await additionalTvDiscount(env);
      const computed = computeTotal(tvs, addons, byCode, discount);

      if (!admin || computed.total > 0) {
        if (computed.total !== finalTotal) {
          // Worth a line in the log either way: a mismatch means the page and
          // the server disagree, which is either a stale cached page or
          // somebody editing the request.
          console.warn(`Booking total recomputed: page said ${finalTotal}, price list says ${computed.total}`);
        }
        finalTotal = computed.total;
      }
    } catch (err) {
      // A pricing failure must not lose the booking. Fall back to the number
      // sent, and shout about it in the log.
      console.error('Could not price this booking from the price list:', err);
    }
  }

  const receiptToken = newReceiptToken();

  const result = await env.DB.prepare(
    `INSERT INTO bookings
      (source, status, address, lat, lng, in_service_area, dismount, size, bracket, wall, wires, addons, total_price, booking_date, booking_time, name, phone, notes, receipt_token, tvs_json, sms_consent, lead_source, attribution_json, meta_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    source, 'new', address, lat, lng, inServiceArea ? 1 : 0,
    dismount, size, bracket, wall, wires, JSON.stringify(addons || []),
    finalTotal, date, time, name, phone, notes, receiptToken,
    tvs && tvs.length ? JSON.stringify(tvs) : null,
    smsConsent ? 1 : 0,
    leadSource, attributionJson, metaJson
  ).run();

  const bookingId = result.meta.last_row_id;

  // A template variable must always carry a value — an empty one is how a
  // client ends up reading "confirmed for  ." So the date and time collapse
  // into one phrase here, with a sane wording when neither was chosen.
  const when = [date, time].filter(Boolean).join(' at ') || 'your requested time';

  // SMS confirmation to the client — only if they opted in. Consent is
  // never required to book; this just means we stay quiet if they didn't.
  if (phone && smsConsent) {
    await sendSms(
      env,
      phone,
      `Mount It Right: booking confirmed for ${when}. Total: $${finalTotal}. We'll text you when your installer is on the way.`,
      { template: 'BOOKING_CONFIRMED', params: { when, total: finalTotal } }
    );
  }

  // Notify admins/masters — SMS + email, from env vars plus notify_recipients table
  const { results: recipients } = await env.DB.prepare(
    `SELECT type, value FROM notify_recipients WHERE active = 1`
  ).all();

  const smsNumbers = [
    ...(env.NOTIFY_SMS_NUMBERS ? env.NOTIFY_SMS_NUMBERS.split(',').map(s => s.trim()) : []),
    ...recipients.filter(r => r.type === 'sms').map(r => r.value),
  ];
  const emails = [
    ...(env.NOTIFY_EMAILS ? env.NOTIFY_EMAILS.split(',').map(s => s.trim()) : []),
    ...recipients.filter(r => r.type === 'email').map(r => r.value),
  ];

  // Plain hyphens, not em dashes: an em dash is outside GSM-7, which pushes
  // the whole SMS into UCS-2 encoding — that drops the per-segment limit from
  // 160 characters to 70 and multiplies the cost of every staff alert.
  const summary = `New ${source} booking #${bookingId} - $${finalTotal} - ${name || 'no name'} - ${address || 'no address'}`;
  // Staff numbers need a template too. They're our own people, but as far as
  // the carriers are concerned they're first-time recipients like anyone else.
  if (smsNumbers.length) {
    await sendSmsToMany(env, smsNumbers, summary, {
      template: 'STAFF_ALERT',
      params: { message: summary },
    });
  }
  if (emails.length) await sendEmail(env, emails, `New booking — $${finalTotal}`, summary);

  // Push goes to every active master and admin, taken from the users table —
  // deliberately not the notify_recipients list the SMS above uses. That list
  // is hand-maintained, so a newly hired master silently gets nothing until
  // someone remembers to add their number. Anyone who can claim a job should
  // hear about it the moment they're given an account.
  try {
    await sendPushToUsers(env, await activeStaffIds(env), {
      title: `New booking - $${finalTotal}`,
      body: [name, address].filter(Boolean).join(' - ') || `Booking #${bookingId}`,
      data: { type: 'new_booking', bookingId: Number(bookingId) },
    });
  } catch (err) {
    console.error('Push notification failed (booking was still saved):', err);
  }

  return Response.json({ ok: true, id: bookingId });
}

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  // Both admins and masters see every booking — masters need full visibility
  // to judge which unclaimed jobs to accept, and to see what teammates are
  // working on. Client-side filtering (e.g. "My Jobs") narrows this down.
  const query = `
    SELECT bookings.*, u.name AS claimed_by_name
    FROM bookings
    LEFT JOIN users u ON u.id = bookings.claimed_by
    ORDER BY (booking_date IS NULL), booking_date, booking_time`;
  const { results } = await env.DB.prepare(query).all();
  return Response.json({ ok: true, bookings: results });
}
