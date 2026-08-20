// Sends an SMS via Twilio. Best-effort: logs and swallows errors so a
// notification failure never breaks the booking flow itself.
export async function sendSms(env, to, body) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    console.warn('Twilio not configured — skipping SMS to', to);
    return { ok: false, skipped: true };
  }
  if (!to) return { ok: false, skipped: true };

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    const ok = res.ok;
    if (!ok) console.error('Twilio error', await res.text());
    return { ok };
  } catch (err) {
    console.error('Twilio send failed', err);
    return { ok: false, error: String(err) };
  }
}

// Sends the same SMS to a list of numbers (used for admin notifications).
export async function sendSmsToMany(env, numbers, body) {
  const results = await Promise.all((numbers || []).map(n => sendSms(env, n, body)));
  return results;
}
