// POST /api/stripe/onboard-business { businessName? } — admin only.
// Same idea as onboard-master.js, but for the business side. Given how
// this project is set up, "Mount It Right" is the default and, for now,
// the only business — this stays generic so a second business slots in
// later without changing this endpoint.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

// Where Stripe sends the person back to when they finish (or abandon) the
// form. Both pages live in this repo, so they're served by this project.
// This used to read `${env.SITE_URL}` with no fallback — the only place in
// the codebase that did — so with the variable unset Stripe was handed
// "undefined/stripe-onboarding-done.html", rejected the request, and the
// whole thing surfaced as an unparseable HTML error page.
const DEFAULT_SITE_URL = 'https://sketrix.com';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'admin') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const businessName = body.businessName || 'Mount It Right';

  const biz = await env.DB.prepare(`SELECT * FROM businesses WHERE name = ?`).bind(businessName).first();
  if (!biz) return Response.json({ ok: false, error: 'Business not found' }, { status: 404 });

  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;

  // Everything that talks to Stripe is wrapped, so a Stripe-side problem
  // (Connect not enabled on the platform account, an invalid URL, a key from
  // the wrong account) comes back as a readable sentence instead of a 500.
  try {
    let accountId = biz.stripe_account_id;
    if (!accountId) {
      const account = await stripeRequest(env, 'POST', 'accounts', {
        type: 'express',
        email: user.email || undefined,
        business_type: 'company',
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      await env.DB.prepare(`UPDATE businesses SET stripe_account_id = ? WHERE id = ?`).bind(accountId, biz.id).run();
    }

    const link = await stripeRequest(env, 'POST', 'account_links', {
      account: accountId,
      refresh_url: `${siteUrl}/stripe-onboarding-refresh.html`,
      return_url: `${siteUrl}/stripe-onboarding-done.html`,
      type: 'account_onboarding',
    });

    return Response.json({ ok: true, url: link.url });
  } catch (err) {
    console.error('Stripe business onboarding failed:', err);
    return Response.json(
      { ok: false, error: err?.message || 'Stripe rejected the onboarding request.' },
      { status: 502 }
    );
  }
}
