// Apple Push Notification service, straight from Cloudflare Workers.
//
// No Firebase, no SDK, no Node polyfills. APNs speaks plain HTTPS with a
// JSON body and a JWT in the Authorization header, and Workers can sign that
// JWT with the Web Crypto API it already has. That's the whole integration.
//
// ONE THING TO KNOW: APNs requires HTTP/2. Deployed Workers do this fine, but
// `wrangler dev` running locally on macOS does NOT — the request fails there
// with a protocol error. So if pushes work in production and fail on your
// laptop, nothing is broken; test them deployed.
//
// Cloudflare Pages → your project → Settings → Variables and Secrets:
//   APNS_KEY_ID      — 10 characters, shown next to the key in Apple's portal
//   APNS_TEAM_ID     — 10 characters, top right of the Apple Developer account
//   APNS_BUNDLE_ID   — e.g. com.sketrix.app — must match the app exactly
//   APNS_PRIVATE_KEY — the whole contents of the .p8 file  (type: Secret)
//   APNS_ENV         — 'sandbox' (default) or 'production'
//
// APNS_ENV is the one that quietly bites. A build installed from Xcode or
// `flutter run` is signed for DEVELOPMENT and can only receive pushes from the
// SANDBOX host. TestFlight and App Store builds are PRODUCTION. Send to the
// wrong one and Apple answers BadDeviceToken — the token isn't bad, it just
// belongs to the other environment. Switch this variable when you move the app
// to TestFlight.

const HOSTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
};

// Apple asks providers not to mint a new token more than once every 20
// minutes, and rejects tokens older than an hour. Fifty minutes sits safely
// between the two. The cache lives as long as the isolate does, which is
// exactly the right lifetime — nothing to invalidate, nothing to store.
let cachedJwt = null;
let cachedJwtAt = 0;
const JWT_TTL_MS = 50 * 60 * 1000;

function base64UrlEncode(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

/**
 * Turns the contents of the .p8 file into a signing key.
 *
 * Pasting a multi-line PEM into a dashboard field is a coin flip — some paths
 * preserve the newlines, some deliver the whole thing as one line with a
 * literal backslash-n. Both are accepted here, along with a key pasted with no
 * PEM header at all.
 */
async function importPrivateKey(pem) {
  const normalised = String(pem).replace(/\\n/g, '\n');
  const body = normalised
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');

  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

  return crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function getApnsJwt(env) {
  const now = Date.now();
  if (cachedJwt && now - cachedJwtAt < JWT_TTL_MS) return cachedJwt;

  const header = { alg: 'ES256', kid: env.APNS_KEY_ID };
  const payload = { iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;

  const key = await importPrivateKey(env.APNS_PRIVATE_KEY);
  // WebCrypto returns the raw r||s pair, which is exactly what JWS ES256
  // wants — no DER unwrapping needed, unlike most server-side crypto libraries.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );

  cachedJwt = `${signingInput}.${base64UrlEncode(signature)}`;
  cachedJwtAt = now;
  return cachedJwt;
}

/**
 * Sends one push to every device token belonging to the given users.
 *
 * Best-effort, like the SMS layer: a failure here is logged and swallowed, so
 * a push problem can never stop a booking from being saved or a message from
 * being delivered.
 *
 * @param {object} env
 * @param {number[]} userIds  who should get it
 * @param {object} notification
 * @param {string} notification.title
 * @param {string} notification.body
 * @param {object} [notification.data]  extra fields the app can read on tap,
 *                                      e.g. { type: 'new_message', bookingId: 42 }
 */
export async function sendPushToUsers(env, userIds, notification) {
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_BUNDLE_ID || !env.APNS_PRIVATE_KEY) {
    console.warn('APNs not configured — skipping push');
    return { ok: false, skipped: true };
  }

  const ids = [...new Set((userIds || []).filter((id) => id != null))];
  if (!ids.length) return { ok: true, sent: 0 };

  const placeholders = ids.map(() => '?').join(',');
  const { results: rows } = await env.DB.prepare(
    `SELECT token, user_id FROM device_tokens WHERE user_id IN (${placeholders})`
  ).bind(...ids).all();

  if (!rows.length) return { ok: true, sent: 0 };

  let jwt;
  try {
    jwt = await getApnsJwt(env);
  } catch (err) {
    console.error('Could not sign APNs token — check APNS_PRIVATE_KEY:', err);
    return { ok: false, error: String(err) };
  }

  const host = HOSTS[env.APNS_ENV === 'production' ? 'production' : 'sandbox'];

  const payload = JSON.stringify({
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: 'default',
      'content-available': 0,
    },
    ...(notification.data || {}),
  });

  const dead = [];
  let sent = 0;

  await Promise.all(rows.map(async (row) => {
    try {
      const res = await fetch(`${host}/3/device/${row.token}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': env.APNS_BUNDLE_ID,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body: payload,
      });

      if (res.ok) {
        sent++;
        return;
      }

      const text = await res.text();
      console.error('APNs rejected a push', res.status, text);

      // 410 means the app was deleted from that phone; BadDeviceToken means
      // the token doesn't belong to this environment or app. Either way the
      // row is junk and keeping it just slows every future send.
      if (res.status === 410 || text.includes('BadDeviceToken') || text.includes('Unregistered')) {
        dead.push(row.token);
      }
    } catch (err) {
      console.error('APNs request failed', err);
    }
  }));

  if (dead.length) {
    try {
      const marks = dead.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM device_tokens WHERE token IN (${marks})`).bind(...dead).run();
    } catch (err) {
      console.error('Could not clean up dead device tokens', err);
    }
  }

  return { ok: true, sent, removed: dead.length };
}

/** Every active master and admin — the audience for a new booking. */
export async function activeStaffIds(env) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM users WHERE active = 1 AND role IN ('master', 'admin')`
  ).all();
  return results.map((r) => r.id);
}
