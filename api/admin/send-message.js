// api/admin/send-message.js
//
// Send a message (email OR SMS) from the CRM. Routes internally by `channel`
// so we stay under the Vercel Hobby 12-function cap.
//
// POST body:
//   Common:
//     { channel: 'email' | 'sms',            // required
//       body: 'Message body...',             // required
//       customer_email: 'sarah@x.com' }      // required for activity log
//
//   Email (channel='email'):
//     { to: 'customer@example.com',           // required
//       from: 'refresh@justrebe.com',         // required; must be allowed for user
//       subject: 'Hello' }                    // required
//
//   SMS (channel='sms'):
//     { to: '+15551234567',                   // E.164 preferred; we normalize
//       provider: 'openphone' | 'twilio' }    // optional; defaults to 'openphone'
//
// Required env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (auth + log)
//   RESEND_API_KEY                             (email)
//   OPENPHONE_API_KEY, OPENPHONE_FROM_NUMBER   (SMS via OpenPhone)
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN      (SMS via Twilio)
//   TWILIO_PHONE_NUMBER                        (Twilio "from" — default +19412696448)

const { requireAdminStaff, allowedSendersForUser, logActivity } = require('./_admin-auth.js');

// ---------- SMS helpers ----------
function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(p || '').startsWith('+')) return String(p);
  return `+${digits}`;
}

async function sendViaOpenPhone(normPhone, body) {
  const apiKey = process.env.OPENPHONE_API_KEY;
  const fromNum = process.env.OPENPHONE_FROM_NUMBER;
  if (!apiKey || !fromNum) {
    return { error: 'OPENPHONE_API_KEY or OPENPHONE_FROM_NUMBER not configured', fromNum };
  }
  try {
    const r = await fetch('https://api.openphone.com/v1/messages', {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromNum, to: [normPhone], content: body }),
    });
    const data = await r.json();
    if (!r.ok) {
      return { error: (data && (data.message || data.error)) || `HTTP ${r.status}`, fromNum, data };
    }
    const messageId = data.id || (data.data && data.data.id);
    return { ok: true, fromNum, messageId, data };
  } catch (err) {
    return { error: String(err && err.message || err), fromNum };
  }
}

async function sendViaTwilio(normPhone, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNum    = process.env.TWILIO_PHONE_NUMBER || '+19412696448';
  if (!accountSid || !authToken) {
    return { error: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not configured', fromNum };
  }
  try {
    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: fromNum, To: normPhone, Body: body }).toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      return { error: (data && (data.message || data.error_message)) || `HTTP ${r.status}`, fromNum, data };
    }
    return { ok: true, fromNum, messageId: data.sid, data };
  } catch (err) {
    return { error: String(err && err.message || err), fromNum };
  }
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireAdminStaff(req);
  if (auth.error) return res.status(auth.error.status).json({ error: auth.error.msg });
  const { user } = auth;

  const channel = String((req.body && req.body.channel) || '').toLowerCase();
  if (channel !== 'email' && channel !== 'sms') {
    return res.status(400).json({ error: "channel must be 'email' or 'sms'" });
  }

  // ===== EMAIL =====
  if (channel === 'email') {
    const { to, from, subject, body } = req.body || {};
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: 'Valid recipient email required' });
    }
    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ error: 'Subject required' });
    }
    if (!body || !String(body).trim()) {
      return res.status(400).json({ error: 'Body required' });
    }
    if (!from) {
      return res.status(400).json({ error: 'Sender required' });
    }

    const allowed = allowedSendersForUser(user.email);
    if (!allowed.find((s) => s.email.toLowerCase() === from.toLowerCase())) {
      return res.status(403).json({
        error: 'Sender not allowed for this user',
        allowed: allowed.map((s) => s.email),
      });
    }

    const senderInfo = allowed.find((s) => s.email.toLowerCase() === from.toLowerCase());
    const fromHeader = senderInfo.label
      ? `${senderInfo.label} <${senderInfo.email}>`
      : senderInfo.email;

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) {
      return res.status(500).json({ error: 'RESEND_API_KEY not configured' });
    }

    let resendData = null;
    let sendError = null;
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromHeader,
          to,
          subject: String(subject).trim(),
          text: String(body),
          reply_to: from,
        }),
      });
      resendData = await r.json();
      if (!r.ok) sendError = resendData.message || resendData.error || `HTTP ${r.status}`;
    } catch (err) {
      sendError = String(err && err.message || err);
    }

    await logActivity({
      customerEmail: to,
      type: 'email_sent',
      body: String(body),
      subject: String(subject).trim(),
      fromAddr: from,
      toAddr: to,
      actorId: user.id,
      actorEmail: user.email,
      metadata: { resend_id: resendData && resendData.id, sender_label: senderInfo.label },
      status: sendError ? 'failed' : 'sent',
      errorMessage: sendError,
    });

    if (sendError) {
      return res.status(502).json({ error: 'Resend rejected the email', detail: sendError });
    }
    return res.status(200).json({
      ok: true,
      channel: 'email',
      message_id: resendData && resendData.id,
      sent_from: from,
      sent_to: to,
    });
  }

  // ===== SMS =====
  const { to, body, customer_email, provider } = req.body || {};
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'Message body required' });
  }
  const normPhone = normalizePhone(to);
  if (!normPhone || normPhone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ error: 'Valid recipient phone required (E.164 preferred)' });
  }

  const chosenProvider = String(provider || 'openphone').toLowerCase();
  const trimmedBody = String(body).trim();

  const result = chosenProvider === 'twilio'
    ? await sendViaTwilio(normPhone, trimmedBody)
    : await sendViaOpenPhone(normPhone, trimmedBody);

  await logActivity({
    customerEmail: (customer_email || normPhone).toLowerCase(),
    type: 'sms_sent',
    body: trimmedBody,
    subject: null,
    fromAddr: result.fromNum,
    toAddr: normPhone,
    actorId: user.id,
    actorEmail: user.email,
    metadata: {
      provider: chosenProvider,
      message_id: result.messageId,
      raw: result.data,
    },
    status: result.error ? 'failed' : 'sent',
    errorMessage: result.error,
  });

  if (result.error) {
    return res.status(502).json({
      error: `${chosenProvider === 'twilio' ? 'Twilio' : 'OpenPhone'} rejected the message`,
      detail: result.error,
    });
  }

  return res.status(200).json({
    ok: true,
    channel: 'sms',
    provider: chosenProvider,
    message_id: result.messageId,
    sent_from: result.fromNum,
    sent_to: normPhone,
  });
};
