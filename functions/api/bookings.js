// POST /api/bookings — create a booking (public site, or admin/phone entry)
// GET  /api/bookings — list bookings (auth required; admin sees all, master
//                       sees unclaimed jobs plus their own claimed jobs)
import { getUserFromRequest } from '../_lib/auth.js';
import { sendSms, sendSmsToMany } from '../_lib/sms.js';
import { sendEmail } from '../_lib/email.js';

function newReceiptToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
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
  const source = admin && body.source ? body.source : 'online';

  const {
    address = null, lat = null, lng = null, inServiceArea = null,
    dismount = null, size = null, bracket = null, wall = null, wires = null,
    addons = [], total = 0, date = null, time = null,
    name = null, phone = null, notes = null, tvs = null, smsConsent = false,
  } = body;

  const receiptToken = newReceiptToken();

  const result = await env.DB.prepare(
    `INSERT INTO bookings
      (source, status, address, lat, lng, in_service_area, dismount, size, bracket, wall, wires, addons, total_price, booking_date, booking_time, name, phone, notes, receipt_token, tvs_json, sms_consent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    source, 'new', address, lat, lng, inServiceArea ? 1 : 0,
    dismount, size, bracket, wall, wires, JSON.stringify(addons || []),
    total, date, time, name, phone, notes, receiptToken,
    tvs && tvs.length ? JSON.stringify(tvs) : null,
    smsConsent ? 1 : 0
  ).run();

  const bookingId = result.meta.last_row_id;

  // SMS confirmation to the client — only if they opted in. Consent is
  // never required to book; this just means we stay quiet if they didn't.
  if (phone && smsConsent) {
    await sendSms(env, phone,
      `Mount It Right: booking confirmed${date ? ' for ' + date : ''}${time ? ' at ' + time : ''}. Total: $${total}. We'll text you when your installer is on the way.`
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

  const summary = `New ${source} booking #${bookingId} — $${total} — ${name || 'no name'} — ${address || 'no address'}`;
  if (smsNumbers.length) await sendSmsToMany(env, smsNumbers, summary);
  if (emails.length) await sendEmail(env, emails, `New booking — $${total}`, summary);

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
