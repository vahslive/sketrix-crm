// Shared authentication helpers for Cloudflare Pages Functions.
// Password hashing uses PBKDF2 via the Web Crypto API (available in Workers).

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes.buffer;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return `pbkdf2$${bufToHex(salt)}$${bufToHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  const parts = (stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const salt = new Uint8Array(hexToBuf(parts[1]));
  const expectedHex = parts[2];
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return bufToHex(bits) === expectedHex;
}

export function newToken() {
  return bufToHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

// Reads the Authorization: Bearer <token> header, checks it against the
// sessions table, and returns the associated user row (or null).
export async function getUserFromRequest(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const session = await env.DB.prepare(
    `SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  if (!session) return null;

  const user = await env.DB.prepare(
    `SELECT id, name, email, phone, role, active FROM users WHERE id = ?`
  ).bind(session.user_id).first();
  if (!user || !user.active) return null;

  return user;
}

export function requireRole(user, roles) {
  return !!user && roles.includes(user.role);
}
