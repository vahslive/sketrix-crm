// GET /api/authorizations — admin only. Every customer approval ever taken.
//
// This is the evidence drawer. When a landlord calls six months from now about
// holes in a wall, the answer is a row here: who signed, whether they said they
// owned or rented the place, when, from which device, and the exact version of
// the wording they were shown. The drawn signature itself lives in R2 and is
// linked, not stored in the database.
//
// Pending rows are included deliberately. A job whose approval was requested
// but never signed is worth seeing — it usually means the link was texted and
// the customer never opened it.
import { getUserFromRequest } from '../_lib/auth.js';

// Generous, because the whole point is to be able to search the history. At a
// few hundred jobs a year this holds several years of work; past that the
// response says it was truncated rather than quietly dropping the oldest.
const MAX_ROWS = 1000;

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { results } = await env.DB.prepare(
    `SELECT a.booking_id, a.status, a.customer_name, a.property_status,
            a.signed_at, a.signed_via, a.signed_ip, a.agreement_version,
            a.signature_url, a.quoted_total, a.created_at,
            b.address, b.name AS booked_name, b.phone,
            b.booking_date, b.status AS booking_status,
            b.total_price, b.actual_total,
            u.name AS master_name
     FROM job_authorizations a
     JOIN bookings b ON b.id = a.booking_id
     LEFT JOIN users u ON u.id = b.claimed_by
     ORDER BY COALESCE(a.signed_at, a.created_at) DESC
     LIMIT ?`
  ).bind(MAX_ROWS + 1).all();

  const rows = results || [];
  const truncated = rows.length > MAX_ROWS;
  if (truncated) rows.length = MAX_ROWS;

  const signed = rows.filter((r) => r.status === 'signed');

  return Response.json({
    ok: true,
    truncated,
    authorizations: rows,
    counts: {
      total: rows.length,
      signed: signed.length,
      pending: rows.length - signed.length,
      tenants: signed.filter((r) => r.property_status === 'tenant').length,
    },
  });
}
