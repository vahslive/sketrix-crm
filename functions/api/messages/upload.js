// POST /api/messages/upload — multipart/form-data with a single "file"
// field. Uploads it to R2 under a random key (so URLs aren't guessable)
// and returns the public URL to attach to a chat message.
import { getUserFromRequest } from '../../_lib/auth.js';

const MAX_BYTES = 15 * 1024 * 1024; // 15MB — generous for photos, keeps R2 costs sane
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

// The R2 bucket's public base URL — set this once you enable public
// access and copy the pub-xxxxx.r2.dev address from the bucket settings.
const R2_PUBLIC_BASE = 'https://pub-3fa5ac77537b4c63a8a0fcf1f561b596.r2.dev';

function randomKey(originalName) {
  const rand = [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const ext = (originalName.split('.').pop() || 'bin').toLowerCase().slice(0, 8);
  return `${rand}.${ext}`;
}

export async function onRequestPost({ request, env }) {
  const user = await getUserFromRequest(request, env);
  if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

  let form;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: 'Expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return Response.json({ ok: false, error: 'Missing file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ ok: false, error: 'File is too large (15MB max).' }, { status: 400 });
  }

  const key = randomKey(file.name || 'upload');
  await env.CHAT_FILES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return Response.json({
    ok: true,
    url: `${R2_PUBLIC_BASE}/${key}`,
    type: IMAGE_TYPES.includes(file.type) ? 'image' : 'file',
    name: file.name || key,
  });
}
