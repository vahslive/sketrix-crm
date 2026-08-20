// Sends an email via Resend. Best-effort — never throws.
export async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) {
    console.warn('Resend not configured — skipping email to', to);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Mount It Right <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to],
        subject,
        text,
      }),
    });
    const ok = res.ok;
    if (!ok) console.error('Resend error', await res.text());
    return { ok };
  } catch (err) {
    console.error('Resend send failed', err);
    return { ok: false, error: String(err) };
  }
}
