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

  let response;
  try {
    response = await next();
  } catch (err) {
    // An endpoint threw and nobody caught it. Cloudflare's own answer to that
    // is an HTML error page — which every caller here then tries to parse as
    // JSON, producing the famously unhelpful:
    //     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
    // The real cause is buried underneath. So for anything under /api/ we
    // answer in the shape callers expect, carrying the actual message.
    const path = new URL(request.url).pathname;
    console.error(`Unhandled error in ${path}:`, err);

    // Answered as 400, not 500, on purpose. Cloudflare intercepts any 5xx an
    // app returns and serves its own "Bad gateway" page instead — so a 500
    // here would throw away the very message this handler exists to deliver,
    // and every distinct failure would reach the browser looking the same.
    // Being able to read the cause is worth more than the tidier status code.
    if (path.startsWith('/api/')) {
      return new Response(
        JSON.stringify({ ok: false, error: err?.message || 'Server error' }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': allowOrigin,
          },
        }
      );
    }

    throw err; // a page request — let Cloudflare show its normal error page
  }

  // WebSocket upgrade responses carry a special `webSocket` property that
  // isn't part of body/status/headers — rebuilding the Response for CORS
  // purposes silently drops it and breaks the upgrade. CORS headers don't
  // meaningfully apply to a WebSocket handshake anyway, so just pass these
  // straight through untouched.
  if (response.webSocket) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowOrigin);
  return new Response(response.body, { status: response.status, headers });
}
