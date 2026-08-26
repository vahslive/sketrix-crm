// GET /api/stripe/account-status[?business=Mount It Right]
// Checks Stripe directly (not just our cached flag) so onboarding
// progress shows up the moment the master/admin actually finishes it,
// even if they never come back through our own return_url page.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const businessName = url.searchParams.get('business');

  let accountId;
  if (businessName) {
    if (user.role !== 'admin') return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const biz = await env.DB.prepare(`SELECT stripe_account_id FROM businesses WHERE name = ?`).bind(businessName).first();
    accountId = biz?.stripe_account_id;
  } else {
    const row = await env.DB.prepare(`SELECT stripe_account_id FROM users WHERE id = ?`).bind(user.id).first();
    accountId = row?.stripe_account_id;
  }

  if (!accountId) return Response.json({ ok: true, onboarded: false, hasAccount: false });

  const account = await stripeRequest(env, 'GET', `accounts/${accountId}`);
  const onboarded = !!account.details_submitted && !!(account.charges_enabled || account.payouts_enabled);

  // Keep our own record in sync so other parts of the app don't need a
  // live Stripe call just to know "is this master ready to get paid."
  if (businessName) {
    await env.DB.prepare(`UPDATE businesses SET stripe_onboarding_complete = ? WHERE stripe_account_id = ?`)
      .bind(onboarded ? 1 : 0, accountId).run();
  } else {
    await env.DB.prepare(`UPDATE users SET stripe_onboarding_complete = ? WHERE stripe_account_id = ?`)
      .bind(onboarded ? 1 : 0, accountId).run();
  }

  return Response.json({ ok: true, onboarded, hasAccount: true, detailsSubmitted: account.details_submitted });
}
