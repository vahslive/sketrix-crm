// GET /api/chat-connect?master_id=X&token=Y — upgrades to a WebSocket
// connected to that master's live chat room (Durable Object). Every
// message sent about any of that master's jobs gets pushed here instantly.
//
// Auth note: browsers' native WebSocket API can't send custom headers on
// the handshake, so unlike our other endpoints, the session token travels
// as a query param here — checked against the sessions table by hand.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const masterId = url.searchParams.get('master_id');
  const token = url.searchParams.get('token');
  if (!masterId || !token) {
    return new Response('Missing master_id or token', { status: 400 });
  }

  const session = await env.DB.prepare(
    `SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')`
  ).bind(token).first();
  if (!session) return new Response('Unauthorized', { status: 401 });

  const user = await env.DB.prepare(
    `SELECT id, role FROM users WHERE id = ? AND active = 1`
  ).bind(session.user_id).first();
  if (!user) return new Response('Unauthorized', { status: 401 });

  // Masters may only open their own room; admins can open any master's.
  if (user.role === 'master' && String(user.id) !== String(masterId)) {
    return new Response('Forbidden', { status: 403 });
  }

  const id = env.CHAT_ROOM.idFromName(`master:${masterId}`);
  const room = env.CHAT_ROOM.get(id);
  return room.fetch(request);
}
