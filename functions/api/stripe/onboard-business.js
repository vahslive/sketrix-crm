// POST /api/stripe/onboard-business { businessName? } — admin only.
// Same idea as onboard-master.js, but for the business side. Given how
// this project is set up, "Mount It Right" is the default and, for now,
// the only business — this stays generic so a second business slots in
// later without changing this endpoint.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

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
    refresh_url: `${env.SITE_URL}/stripe-onboarding-refresh.html`,
    return_url: `${env.SITE_URL}/stripe-onboarding-done.html`,
    type: 'account_onboarding',
  });

  return Response.json({ ok: true, url: link.url });
}
