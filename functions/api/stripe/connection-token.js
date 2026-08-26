// POST /api/stripe/connection-token — the Stripe Terminal SDK calls this
// (indirectly, via our app) every time it initializes on the master's
// phone. Just proxies to Stripe; nothing to store.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const token = await stripeRequest(env, 'POST', 'terminal/connection_tokens', {});
  return Response.json({ ok: true, secret: token.secret });
}
