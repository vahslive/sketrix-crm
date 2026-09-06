// GET /api/agreement/public — no auth.
//
// Feeds install-terms.html, the page the customer opens from "Read the full
// terms" on the signing screen. Public because the terms are meant to be read
// by anyone about to have holes drilled in their wall.
//
// A version can be requested explicitly (?v=2026-09-06) so a link inside an
// old signed record shows the wording that was actually agreed, rather than
// whatever has been published since.
import { activeAgreement, agreementByVersion } from '../../_lib/agreement.js';

export async function onRequestGet({ request, env }) {
  const wanted = new URL(request.url).searchParams.get('v');

  const agreement = wanted
    ? (await agreementByVersion(env, wanted)) || (await activeAgreement(env))
    : await activeAgreement(env);

  return Response.json({
    ok: true,
    version: agreement.version,
    summary: agreement.summary,
    fullText: agreement.fullText,
  }, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
