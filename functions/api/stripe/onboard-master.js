// POST /api/stripe/onboard-master — creates (if needed) a Stripe Express
// connected account for the requesting master, then returns a fresh
// onboarding link for the app to show in an in-app browser.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

// See the note in onboard-business.js — same missing fallback lived here.
const DEFAULT_SITE_URL = 'https://sketrix.com';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const row = await env.DB.prepare(`SELECT stripe_account_id FROM users WHERE id = ?`).bind(user.id).first();
  const siteUrl = env.SITE_URL || DEFAULT_SITE_URL;

  try {
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
      refresh_url: `${siteUrl}/stripe-onboarding-refresh.html`,
      return_url: `${siteUrl}/stripe-onboarding-done.html`,
      type: 'account_onboarding',
    });

    return Response.json({ ok: true, url: link.url });
  } catch (err) {
    console.error('Stripe master onboarding failed:', err);
    // 400, not 5xx — Cloudflare swaps any 5xx for its own error page and the
    // message below would be lost. See the same note in onboard-business.js.
    return Response.json(
      { ok: false, error: err?.message || 'Stripe rejected the onboarding request.' },
      { status: 400 }
    );
  }
}
