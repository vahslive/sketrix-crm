// SMS delivery. Best-effort throughout: every failure is logged and
// swallowed so a notification problem never breaks a booking.
//
// Two providers, chosen by which environment variables are set. Sent
// (sent.dm) wins if its key is present; otherwise this falls back to Twilio
// exactly as before. Add one variable in Cloudflare to switch, delete it to
// switch back — no code change either way.
//
// WHY TEMPLATES: Sent blocks free-form SMS to a contact who has never
// replied to you (their CONVERSATION_TEMPLATE_REQUIRED rule) — which is
// every client we have, since we always text first. So each message type
// here names a pre-approved template, and the changing parts (arrival time,
// master's name, totals) travel as parameters. The plain `body` string is
// still built by every caller and is still what Twilio sends, so nothing
// regresses if you switch back, and it's used as a fallback if a template
// ID hasn't been configured yet.
//
// Cloudflare Pages → your project → Settings → Variables and Secrets:
//   SENT_API_KEY                    — required to use Sent (type: Secret)
//   SENT_CHANNEL                    — optional, defaults to 'sms'. Accepts
//                                     'whatsapp' or 'rcs' too, or a list
//                                     like 'rcs,sms' to prefer the richer
//                                     channel with SMS as the fallback.
//   SENT_TEMPLATE_BOOKING_CONFIRMED — template IDs (UUIDs) copied from the
//   SENT_TEMPLATE_ON_THE_WAY          Sent dashboard once each template is
//   SENT_TEMPLATE_JOB_COMPLETE        approved. Any one of these that is
//   SENT_TEMPLATE_STAFF_ALERT         missing simply falls back to sending
//   SENT_TEMPLATE_TEAM_INVITE         free text for that message type.
//
// The sending number / sender profile lives in the Sent dashboard, not
// here — unlike Twilio there is no "from" to pass per message.

const SENT_ENDPOINT = 'https://api.sent.dm/v3/messages';

/**
 * Sends one SMS. Returns { ok } — callers ignore the result and carry on
 * regardless, which is deliberate: an undelivered "on my way" text is
 * annoying, a booking that fails to save is a lost job.
 *
 * @param {object} env    Cloudflare environment bindings
 * @param {string} to     recipient phone number, any format
 * @param {string} body   the full message text (used by Twilio, and as a
 *                        fallback when no template is configured)
 * @param {object} [options]
 * @param {string} [options.template] template key, e.g. 'ON_THE_WAY' —
 *                        resolved against SENT_TEMPLATE_<KEY>
 * @param {object} [options.params]   template variables, e.g. { eta: '...' }
 */
export async function sendSms(env, to, body, options = {}) {
  if (!to) return { ok: false, skipped: true };

  if (env.SENT_API_KEY) return sendViaSent(env, to, body, options);
  return sendViaTwilio(env, to, body);
}

async function sendViaSent(env, to, body, options) {
  const channel = (env.SENT_CHANNEL || 'sms')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const templateId = options.template ? env[`SENT_TEMPLATE_${options.template}`] : null;

  if (options.template && !templateId) {
    // Not fatal, but worth shouting about: free text to a first-time contact
    // is exactly what Sent blocks, so this message will probably not arrive.
    console.warn(`No SENT_TEMPLATE_${options.template} configured — falling back to free text, which Sent may block.`);
  }

  const payload = {
    // Sent wants E.164 ("+16025551234"). Numbers typed into the booking form
    // rarely look like that, so normalise before sending.
    to: [toE164(to)],
    channel,
  };

  if (templateId) {
    payload.template = {
      id: templateId,
      // Every value is stringified: a number that arrives as a JSON number
      // where the template expects text is a needless way to fail.
      parameters: stringifyValues(options.params || {}),
    };
  } else {
    payload.text = body;
  }

  try {
    const res = await fetch(SENT_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': env.SENT_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Sent accepts asynchronously: a 2xx means queued, not delivered. It can
    // still turn into BLOCKED (policy) or FAILED (no sending route) a second
    // later, and neither shows up here — check the Activities log in their
    // dashboard when a message doesn't arrive.
    const ok = res.ok;
    if (!ok) console.error('Sent error', res.status, await res.text());
    return { ok, provider: 'sent' };
  } catch (err) {
    console.error('Sent send failed', err);
    return { ok: false, provider: 'sent', error: String(err) };
  }
}

async function sendViaTwilio(env, to, body) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
    console.warn('No SMS provider configured — skipping SMS to', to);
    return { ok: false, skipped: true };
  }

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
    return { ok, provider: 'twilio' };
  } catch (err) {
    console.error('Twilio send failed', err);
    return { ok: false, provider: 'twilio', error: String(err) };
  }
}

function stringifyValues(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = value == null ? '' : String(value);
  }
  return out;
}

/**
 * Best-effort E.164 for US numbers: "(602) 555-1234" -> "+16025551234".
 * Anything already starting with "+" is left alone, and anything that
 * doesn't look like a US number is passed through untouched rather than
 * mangled — better to let the provider reject it with a clear error.
 */
function toE164(raw) {
  const trimmed = String(raw).trim();
  if (trimmed.startsWith('+')) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed;
}

// Sends the same SMS to a list of numbers (used for admin notifications).
export async function sendSmsToMany(env, numbers, body, options = {}) {
  const results = await Promise.all(
    (numbers || []).map((n) => sendSms(env, n, body, options))
  );
  return results;
}
