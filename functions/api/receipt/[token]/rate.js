// POST /api/receipt/:token/rate — public, no auth. The client leaves a
// star rating (and optional feedback text if it's under 5 stars) from
// their receipt page. Looked up by the same unguessable receipt_token.
export async function onRequestPost({ request, env, params }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return Response.json({ ok: false, error: 'Rating must be 1-5.' }, { status: 400 });
  }
  const feedback = typeof body.feedback === 'string' ? body.feedback.slice(0, 2000) : null;

  // The page posts twice: once the moment a star is tapped, then again with
  // the written comment. The second call must not wipe the first — hence
  // COALESCE rather than a plain overwrite, so an empty second post keeps
  // whatever was already there.
  //
  // rated_at records when the customer answered, which is not when the job was
  // finished: a review can land days later, and the admin list is ordered by
  // this so new ones surface at the top.
  const result = await env.DB.prepare(
    `UPDATE bookings
     SET rating = ?, feedback = COALESCE(?, feedback), rated_at = datetime('now')
     WHERE receipt_token = ?`
  ).bind(rating, feedback, params.token).run();

  if (result.meta.changes === 0) {
    return Response.json({ ok: false, error: 'Receipt not found' }, { status: 404 });
  }

  return Response.json({ ok: true });
}
