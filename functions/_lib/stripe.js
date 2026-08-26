// Minimal Stripe REST API client. Cloudflare Pages Functions run on
// Workers, not Node.js — Stripe's official SDK needs Node APIs we don't
// have here, so we talk to Stripe's HTTP API directly with fetch instead.
// Every function in this project that touches Stripe goes through this.

function flattenParams(obj, prefix = '') {
  const pairs = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v && typeof v === 'object') {
          pairs.push(...flattenParams(v, `${paramKey}[${i}]`));
        } else {
          pairs.push([`${paramKey}[${i}]`, String(v)]);
        }
      });
    } else if (value && typeof value === 'object') {
      pairs.push(...flattenParams(value, paramKey));
    } else {
      pairs.push([paramKey, String(value)]);
    }
  }
  return pairs;
}

/**
 * Calls the Stripe API. `path` is relative, e.g. "accounts" or
 * `payment_intents/${id}`. Throws with a readable message on failure.
 */
export async function stripeRequest(env, method, path, params = {}) {
  const pairs = flattenParams(params);
  const usp = new URLSearchParams(pairs);
  const isGet = method === 'GET';

  const res = await fetch(`https://api.stripe.com/v1/${path}${isGet && pairs.length ? '?' + usp.toString() : ''}`, {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    body: isGet ? undefined : usp.toString(),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || 'Stripe request failed');
    err.stripeError = data.error;
    throw err;
  }
  return data;
}
