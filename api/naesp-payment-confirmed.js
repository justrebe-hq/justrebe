// api/naesp-payment-confirmed.js — Vercel serverless function
//
// Called by NAESP-thank-you.html ONCE, on page load, when the URL contains
// ?paid=success&session_id=<...> (Stripe's success_url).
//
// This endpoint:
//   1. Verifies with Stripe that the checkout session is COMPLETE and PAID
//   2. If yes, sends the buyer's "Thank you for your payment" email
//   3. Optionally updates the naesp_orders row (payment_status = 'paid')
//
// Idempotency: naesp_orders.payment_confirmed_email_sent_at is stamped on
// first success. Repeat calls (page refresh, back+forward) no-op instead of
// re-emailing. Column is optional — if it doesn't exist yet, the flow still
// works, just at risk of a duplicate email on refresh.

const {
  renderEmail,
  esc,
  p: htmlP,
  h: htmlH,
  eyebrow: htmlEyebrow,
  callout: htmlCallout,
  detailRows: htmlDetailRows,
  list: htmlList,
  divider: htmlDivider,
} = require('./_email.js');

function supabaseBaseUrl() {
  const rawUrl = process.env.SUPABASE_URL;
  if (!rawUrl) return null;
  return rawUrl.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}
function supabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

const PRODUCT_LABEL = {
  thrive:    'Thrive — Lights + Camera package',
  flourish:  'Flourish — K-2 Health Boosts per grade (+ FREE 3-5 pilot, 1-year license)',
  premiere:  'Literacy Residency Pilot',
  transform: 'Transform — Educator + Student Wellness ★',
  action:    'Action — ReBe ReFresh Live (add-on)',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const session_id = (body.session_id || '').toString().trim();
  if (!session_id.startsWith('cs_')) {
    return res.status(400).json({ error: 'Missing or invalid session_id' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY not set — cannot verify payment');
    return res.status(500).json({ error: 'Payment verification unavailable' });
  }

  // 1. Verify the Stripe session
  let session;
  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session_id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error(`Stripe session lookup ${r.status}:`, detail);
      return res.status(502).json({ error: 'Stripe session lookup failed' });
    }
    session = await r.json();
  } catch (err) {
    console.error('Stripe session lookup threw:', err);
    return res.status(502).json({ error: 'Stripe session lookup failed' });
  }

  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    console.log('Session not yet complete/paid:', session.status, session.payment_status);
    return res.status(200).json({ ok: false, reason: 'Not yet complete', status: session.status, payment_status: session.payment_status });
  }

  // 2. Extract details from Stripe session + metadata
  const buyerEmail = (session.customer_email || session.customer_details?.email || '').toLowerCase();
  const buyerName = session.metadata?.buyer_name || session.customer_details?.name || 'there';
  const firstName = buyerName.split(' ')[0] || 'there';
  const schoolName = session.metadata?.school_name || '';
  const district = session.metadata?.district || '';
  const productKeys = (session.metadata?.products || '').split(',').filter(Boolean);
  const naespOrderId = session.metadata?.naesp_order_id || null;
  const amountTotal = session.amount_total || 0; // cents
  const amountFormatted = '$' + (amountTotal / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  if (!buyerEmail) {
    return res.status(200).json({ ok: false, reason: 'No buyer email on session' });
  }

  // 3. Idempotency check — has this session already been confirmed via email?
  const base = supabaseBaseUrl();
  const key = supabaseKey();
  let alreadySent = false;
  if (base && key && naespOrderId) {
    try {
      const r = await fetch(`${base}/rest/v1/naesp_orders?id=eq.${encodeURIComponent(naespOrderId)}&select=payment_confirmed_email_sent_at`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (r.ok) {
        const rows = await r.json();
        if (rows[0] && rows[0].payment_confirmed_email_sent_at) {
          alreadySent = true;
        }
      }
    } catch (err) {
      // Column may not exist yet — treat as "not sent" and continue.
      console.warn('Idempotency lookup failed (column may not exist):', err.message);
    }
  }

  if (alreadySent) {
    return res.status(200).json({ ok: true, already_sent: true });
  }

  // 4. Send the buyer's "Thank you for your payment" email
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY missing — cannot send payment confirmation');
    return res.status(200).json({ ok: false, reason: 'Resend key missing' });
  }

  const fromAddr = 'ReBe Ed <hello@justrebe.com>';
  const productLines = productKeys.map((k) => `  • ${PRODUCT_LABEL[k] || k}`).join('\n');
  const productListHtml = htmlList(productKeys.map((k) => esc(PRODUCT_LABEL[k] || k)));

  const subject = `Payment received — thank you, ${firstName}`;
  const text =
`Hi ${firstName},

Payment received — thank you!

Your ReBe Ed order for ${schoolName || 'your school'} is confirmed. Stripe should have already sent you a receipt to ${buyerEmail}.

Your order:
${productLines}

Amount paid: ${amountFormatted}

We'll be in touch soon to walk you through next steps and answer any questions.

If you need to reach us before we reach out, reply to this email or write to hello@justrebe.com.

Better me. Better we.

— The ReBe Ed Team
JustReBe LLC
`;

  const html = renderEmail({
    preheader: `Payment received — thank you for choosing ReBe Ed.`,
    body:
      htmlEyebrow('Payment received') +
      htmlH(`Thank you, ${esc(firstName)}.`) +
      htmlP(`Your ReBe Ed order for <strong>${esc(schoolName || 'your school')}</strong> is confirmed. Stripe should have already sent you a receipt to <strong>${esc(buyerEmail)}</strong>.`) +
      htmlCallout(`We'll be in touch soon to walk you through next steps and answer any questions.`, { bg: '#F3FAEC', border: '#DEEBC7', accent: '#638D13' }) +
      htmlP(`<strong>Your order:</strong>`, { margin: '18px 0 4px' }) +
      productListHtml +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 8px;"><tr><td style="padding:14px 20px;background:#FFFBEC;border:2px solid #FEB909;border-radius:10px;text-align:right;"><span style="font:800 11px/1.4 Inter,-apple-system,'Segoe UI',Arial,sans-serif;color:#7A5B00;letter-spacing:0.16em;text-transform:uppercase;">Amount paid</span><br><span style="font:900 28px/1 Inter,-apple-system,'Segoe UI',Arial,sans-serif;color:#023d4f;letter-spacing:-0.02em;">${esc(amountFormatted)}</span></td></tr></table>` +
      htmlDivider() +
      htmlP(`If you need to reach us before we reach out, reply to this email or write to <a href="mailto:hello@justrebe.com" style="color:#034E64;font-weight:700;">hello@justrebe.com</a>.`, { size: '14px' }) +
      htmlP(`<em>Better me. Better we.</em>`, { color: '#7D0AAB', size: '15px' }) +
      htmlP(`&mdash; The ReBe Ed Team<br>JustReBe LLC`, { size: '14px' }),
  });

  const sendEmail = fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddr,
      to: buyerEmail,
      subject,
      text,
      html,
    }),
  }).catch((e) => console.error('Payment-confirmed email failed:', e));

  // Also notify team the payment cleared
  const teamSubject = `[NAESP · PAID ${amountFormatted}] ${schoolName || buyerName}`;
  const teamText =
`Card payment confirmed via Stripe.

  Buyer:       ${buyerName} <${buyerEmail}>
  School:      ${schoolName || '(not on session)'}
  District:    ${district || '(not on session)'}
  Amount:      ${amountFormatted}
  Products:    ${productKeys.join(', ')}
  Session id:  ${session_id}
  Order id:    ${naespOrderId || '(not linked)'}

Buyer received a "Payment received" email with the amount and product list.
`;
  const teamHtml = renderEmail({
    preheader: `${amountFormatted} — ${schoolName || buyerName}`,
    body:
      htmlEyebrow('Card payment confirmed') +
      htmlH(`${esc(schoolName || buyerName)} · ${esc(amountFormatted)}`) +
      htmlP(`Card payment cleared via Stripe. Buyer has been sent the "Payment received" email.`) +
      htmlDetailRows([
        ['Buyer', buyerName],
        ['Email', buyerEmail],
        ['School', schoolName],
        ['District', district],
        ['Amount', amountFormatted],
        ['Products', productKeys.join(', ')],
        ['Stripe session', session_id],
        ['naesp_orders id', naespOrderId || '(not linked)'],
      ]),
  });
  const sendTeam = fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddr,
      to: 'v.ellery@justrebe.com',
      cc: ['a.pace@justrebe.com', 'hello@justrebe.com'],
      reply_to: buyerEmail,
      subject: teamSubject,
      text: teamText,
      html: teamHtml,
    }),
  }).catch((e) => console.error('Payment-confirmed team email failed:', e));

  await Promise.allSettled([sendEmail, sendTeam]);

  // 5. Best-effort mark the order as paid + confirmation sent
  if (base && key && naespOrderId) {
    try {
      await fetch(`${base}/rest/v1/naesp_orders?id=eq.${encodeURIComponent(naespOrderId)}`, {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          payment_status: 'paid',
          payment_confirmed_email_sent_at: new Date().toISOString(),
          stripe_session_id: session_id,
        }),
      });
    } catch (err) {
      // Column may not exist — non-blocking
      console.warn('Failed to mark order as paid (columns may not exist):', err.message);
    }
  }

  return res.status(200).json({ ok: true, sent: true, amount: amountFormatted });
};
