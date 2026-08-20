// Applies to every request under this Pages project (sketrix.com).
// Lets the public site on mountitright.com call this API from JavaScript.
// If you ever add more client sites, just add their origin to the list.
const ALLOWED_ORIGINS = [
  'https://mountitright.com',
  'https://www.mountitright.com',
];

export async function onRequest({ request, next }) {
  const origin = request.headers.get('Origin');
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  // Preflight request — the browser asks permission before the real call.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const response = await next();
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowOrigin);
  return new Response(response.body, { status: response.status, headers });
}
