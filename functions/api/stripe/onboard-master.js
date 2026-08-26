// POST /api/stripe/onboard-master — creates (if needed) a Stripe Express
// connected account for the requesting master, then returns a fresh
// onboarding link for the app to show in an in-app browser.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const row = await env.DB.prepare(`SELECT stripe_account_id FROM users WHERE id = ?`).bind(user.id).first();
  let accountId = row?.stripe_account_id;

  if (!accountId) {
    const account = await stripeRequest(env, 'POST', 'accounts', {
      type: 'express',
      email: user.email || undefined,
      business_type: 'individual',
      capabilities: { transfers: { requested: true } },
    });
    accountId = account.id;
    await env.DB.prepare(`UPDATE users SET stripe_account_id = ? WHERE id = ?`).bind(accountId, user.id).run();
  }

  const link = await stripeRequest(env, 'POST', 'account_links', {
    account: accountId,
    refresh_url: `${env.SITE_URL}/stripe-onboarding-refresh.html`,
    return_url: `${env.SITE_URL}/stripe-onboarding-done.html`,
    type: 'account_onboarding',
  });

  return Response.json({ ok: true, url: link.url });
}
