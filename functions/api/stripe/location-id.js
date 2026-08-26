// GET /api/stripe/location-id — master only. Stripe Terminal requires a
// "Location" resource before it'll connect a reader — this creates one
// for Mount It Right the first time anyone asks, then just reuses it.
import { getUserFromRequest } from '../../_lib/auth.js';
import { stripeRequest } from '../../_lib/stripe.js';

export async function onRequestGet({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user || user.role !== 'master') {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const business = await env.DB.prepare(`SELECT * FROM businesses WHERE name = 'Mount It Right'`).first();
  if (!business) return Response.json({ ok: false, error: 'Business not found' }, { status: 404 });

  if (business.stripe_location_id) {
    return Response.json({ ok: true, locationId: business.stripe_location_id });
  }

  const location = await stripeRequest(env, 'POST', 'terminal/locations', {
    display_name: 'Mount It Right — Phoenix Valley',
    address: {
      // Mount It Right is a mobile-only service with no storefront, so
      // this is a placeholder — Stripe just needs *some* address on file
      // for the Location record. It's never shown to customers. Swap in
      // a real mailing address here if/when you have one on file.
      line1: '1 N Central Ave',
      city: 'Phoenix',
      state: 'AZ',
      country: 'US',
      postal_code: '85004',
    },
  });

  await env.DB.prepare(`UPDATE businesses SET stripe_location_id = ? WHERE id = ?`)
    .bind(location.id, business.id).run();

  return Response.json({ ok: true, locationId: location.id });
}
