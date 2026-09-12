// GET /api/sign/:token — public, no auth.
//
// Feeds the signing page. Looked up by the random token rather than the booking
// id, so the link can be handed to a customer without exposing anything else,
// and can't be walked to find other people's jobs.
import { activeAgreement, AGREEMENT_URL } from '../../_lib/agreement.js';

export async function onRequestGet({ env, params }) {
  const row = await env.DB.prepare(
    `SELECT a.token, a.status, a.customer_name, a.property_status, a.signed_at, a.quoted_total,
            b.id AS booking_id, b.name, b.address, b.booking_date, b.booking_time,
            b.total_price, b.actual_total,
            COALESCE(u.display_name, u.name) AS master_name
     FROM job_authorizations a
     JOIN bookings b ON b.id = a.booking_id
     LEFT JOIN users u ON u.id = b.claimed_by
     WHERE a.token = ?`
  ).bind(params.token).first();

  if (!row) return Response.json({ ok: false, error: 'This link is not valid.' }, { status: 404 });

  // The wording in force right now, not the one recorded when the master asked
  // for the signature. If an admin revised the terms in between, the customer
  // must sign what they are actually being shown — and submit records that
  // version against the signature.
  const agreement = await activeAgreement(env);

  return Response.json({
    ok: true,
    signed: row.status === 'signed',
    signedAt: row.signed_at,
    job: {
      id: row.booking_id,
      customerName: row.name,
      address: row.address,
      date: row.booking_date,
      time: row.booking_time,
      installer: row.master_name,
      total: row.quoted_total ?? row.actual_total ?? row.total_price,
    },
    agreement: {
      version: agreement.version,
      summary: agreement.summary,
      acknowledgements: agreement.acknowledgements,
      fullTextUrl: `${AGREEMENT_URL}?v=${encodeURIComponent(agreement.version)}`,
    },
  });
}
