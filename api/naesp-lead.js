// api/naesp-lead.js — Vercel serverless function
//
// Receives NAESP form submissions (first_name, last_name, email,
// school_organization) from /NAESP-form.html and:
//   1. Stores them in the naesp_leads Supabase table
//   2. Subscribes them to Kit with NAESP lead tags
//   3. Sends an instant auto-response email via Resend
// After success, the form page redirects the visitor to /NAESP-product.html.
//
// Required env vars (already set in Vercel for other endpoints):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   KIT_API_KEY, KIT_API_SECRET  (optional — Kit call no-ops if missing)
//   RESEND_API_KEY               (optional — auto-response no-ops if missing)

const { kitSubscribe } = require('./_kit.js');

function supabaseBaseUrl() {
  const rawUrl = process.env.SUPABASE_URL;
  if (!rawUrl) throw new Error('Missing SUPABASE_URL');
  return rawUrl.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}
function supabaseKey() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  return key;
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
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// PRODUCT_LABEL maps checkbox values -> human-readable labels used in the
// order confirmation and admin notification emails.
const PRODUCT_LABEL = {
  k2_health_boosts: 'K-2 Health Boosts',
  k2_residency:    'K-2 Health Boosts + Residency',
  '35_pilot':      'Free 3-5 Pilot Program',
};
const PAYMENT_LABEL = {
  po:    'Purchase Order (Net 30 invoice)',
  card:  'Credit Card (Stripe link)',
  check: 'Check (payable to JustReBe LLC)',
  ach:   'ACH / Wire Transfer',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON', detail: String(err && err.message || err) });
  }

  // Route by form_type — the purchase-order form sets form_type='naesp_order'.
  // Everything else falls through to the original lead flow.
  if (body.form_type === 'naesp_order') {
    return handleOrder(body, req, res);
  }

  const first_name = (body.first_name || '').toString().trim();
  const last_name = (body.last_name || '').toString().trim();
  const email = (body.email || '').toString().trim().toLowerCase();
  const school_organization = (body.school_organization || '').toString().trim();
  const source = (body.source || 'NAESP form').toString().trim();

  if (!first_name || !last_name || !email || !school_organization) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['first_name', 'last_name', 'email', 'school_organization'],
    });
  }

  // Basic length + shape guard so we don't accept spammy junk.
  if (first_name.length > 120 || last_name.length > 120 || school_organization.length > 240 || email.length > 240) {
    return res.status(400).json({ error: 'Field too long' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const ipHeader = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  const ip = (Array.isArray(ipHeader) ? ipHeader[0] : String(ipHeader)).split(',')[0].trim() || null;
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 500) || null;

  const row = {
    first_name,
    last_name,
    email,
    school_organization,
    source,
    ip_address: ip,
    user_agent: userAgent,
  };

  try {
    const url = supabaseBaseUrl();
    const key = supabaseKey();
    const r = await fetch(`${url}/rest/v1/naesp_leads`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error(`Supabase naesp_leads insert ${r.status}:`, detail);
      return res.status(500).json({ error: 'Save failed', detail });
    }
    const rows = await r.json();
    const inserted = (rows && rows[0]) || null;

    // Kit: subscribe them with the NAESP lead tag set. Failures logged and
    // swallowed so a Kit outage doesn't kill the lead capture flow.
    try {
      await kitSubscribe({
        email,
        first_name,
        tags: ['ReBe — All', 'ReBe Ed — Lead', 'NAESP · 2026'],
      });
    } catch (e) {
      console.error('Kit subscribe (NAESP lead):', e);
    }

    // Resend: instant auto-response to the lead + admin notification.
    // Both fire-and-forget so the API returns fast.
    if (process.env.RESEND_API_KEY) {
      const fromAddr = process.env.NOTIFY_FROM || 'ReBe Ed <hello@justrebe.com>';
      const adminAddr = process.env.NOTIFY_ADMIN || 'hello@justrebe.com';
      const resendKey = process.env.RESEND_API_KEY;

      // Lead auto-response (temporary — replaced by Kit sequence when live)
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: email,
          subject: `Thanks for stopping by, ${first_name} — here's what's next`,
          text:
`Hi ${first_name},

Thanks for your interest in ReBe Ed. We're glad you stopped by.

Here's the offering details and pricing you asked to see:
https://www.justrebe.com/NAESP-product

Three ways to bring ReBe Ed to your school:
  1. K-2 Health Boosts — daily 7-10 minute lessons across the five EPICS
  2. K-2 Health Boosts + Residency — the full package with on-site coaching
  3. Free 3-5 Pilot — for schools ready to lead a case-study cohort

Someone from our team will reach out this week to answer any questions and set up a 20-minute call. If you can't wait, just reply to this email.

Warmly,
The ReBe Ed team
hello@justrebe.com
www.justrebe.com/education`,
        }),
      }).catch((e) => console.error('NAESP lead auto-response failed:', e));

      // Admin notification
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: adminAddr,
          subject: `New NAESP lead — ${first_name} ${last_name} (${school_organization})`,
          text:
`A new NAESP lead just came through.

  Name:          ${first_name} ${last_name}
  Email:         ${email}
  School / Org:  ${school_organization}
  Source:        ${source}
  IP:            ${ip || '(unknown)'}
  Submitted:     ${new Date().toISOString()}

They've been forwarded to /NAESP-product.html and Kit-tagged as
ReBe Ed — Lead + NAESP · 2026. An auto-response has already been sent.

— ReBe Ed / NAESP form`,
        }),
      }).catch((e) => console.error('NAESP admin email failed:', e));
    }

    return res.status(200).json({ ok: true, id: inserted && inserted.id });
  } catch (err) {
    console.error('naesp-lead failed:', err);
    return res.status(500).json({ error: 'Save failed', detail: String(err && err.message || err) });
  }
};

// ============================================================================
// ORDER SUBMISSION HANDLER (naesp_orders)
// Called when form_type === 'naesp_order' (from NAESP-order-form.html).
// - Inserts into naesp_orders
// - Subscribes to Kit with order-specific tags
// - Auto-response to purchaser via Resend
// - Order notification to v.ellery@justrebe.com, cc a.pace@ + hello@
// ============================================================================
async function handleOrder(body, req, res) {
  const first_name = (body.first_name || '').toString().trim();
  const last_name = (body.last_name || '').toString().trim();
  const email = (body.email || '').toString().trim().toLowerCase();
  const school_name = (body.school_name || '').toString().trim();
  const signature_name = (body.signature_name || '').toString().trim();
  const signed_date = (body.signed_date || '').toString().trim();
  const products = Array.isArray(body.products) ? body.products.filter(Boolean) : [];

  if (!first_name || !last_name || !email || !school_name || !signature_name || !signed_date) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['first_name', 'last_name', 'email', 'school_name', 'signature_name', 'signed_date'],
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (products.length === 0) {
    return res.status(400).json({ error: 'At least one product must be selected' });
  }

  const ipHeader = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  const ip = (Array.isArray(ipHeader) ? ipHeader[0] : String(ipHeader)).split(',')[0].trim() || null;
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 500) || null;

  const row = {
    first_name,
    last_name,
    title: (body.title || '').toString().trim() || null,
    phone: (body.phone || '').toString().trim() || null,
    email,
    school_name,
    district: (body.district || '').toString().trim() || null,
    grade_levels: (body.grade_levels || '').toString().trim() || null,
    billing_address: (body.billing_address || '').toString().trim() || null,
    city: (body.city || '').toString().trim() || null,
    state: (body.state || '').toString().trim() || null,
    zip: (body.zip || '').toString().trim() || null,
    purchase_order_number: (body.purchase_order_number || '').toString().trim() || null,
    num_classrooms: (body.num_classrooms || '').toString().trim() || null,
    products,
    payment_method: (body.payment_method || '').toString().trim() || null,
    signature_name,
    signed_date,
    source: (body.source || 'NAESP order form').toString().trim(),
    ip_address: ip,
    user_agent: userAgent,
  };

  try {
    const url = supabaseBaseUrl();
    const key = supabaseKey();
    const r = await fetch(`${url}/rest/v1/naesp_orders`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error(`Supabase naesp_orders insert ${r.status}:`, detail);
      return res.status(500).json({ error: 'Save failed', detail });
    }
    const rows = await r.json();
    const inserted = (rows && rows[0]) || null;

    // Kit: order-submitted tag
    try {
      await kitSubscribe({
        email,
        first_name,
        tags: ['ReBe — All', 'ReBe Ed — Lead', 'NAESP · 2026', 'NAESP · Order Submitted'],
      });
    } catch (e) {
      console.error('Kit subscribe (NAESP order):', e);
    }

    // Resend: auto-response + admin notification
    if (process.env.RESEND_API_KEY) {
      const fromAddr = process.env.NOTIFY_FROM || 'ReBe Ed <hello@justrebe.com>';
      const resendKey = process.env.RESEND_API_KEY;

      const productLines = products.map((p) => `  • ${PRODUCT_LABEL[p] || p}`).join('\n');
      const paymentLine = PAYMENT_LABEL[row.payment_method] || row.payment_method || '(not selected)';

      // Purchaser auto-response
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: email,
          subject: `Thank you for your ReBe Ed order, ${first_name}`,
          text:
`Hi ${first_name},

Thank you for submitting your purchase order for ReBe Ed. We've received it and one of our representatives will follow up shortly — typically within one business day — with a formal quote and next steps.

Here's a summary of what you submitted:

  School / Org:  ${school_name}${row.district ? '\n  District:      ' + row.district : ''}

  Package(s):
${productLines}

  Payment method: ${paymentLine}

If you have questions in the meantime, just reply to this email or reach out directly:
  Valerie Ellery  — v.ellery@justrebe.com  (941) 704-1956
  Abbey Pace      — a.pace@justrebe.com   (704) 975-9180

Thank you for bringing ReBe Ed to your students.

Warmly,
The ReBe Ed team
hello@justrebe.com
www.justrebe.com/education`,
        }),
      }).catch((e) => console.error('NAESP order auto-response failed:', e));

      // Admin / team notification — to v.ellery, cc a.pace + hello
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: 'v.ellery@justrebe.com',
          cc: ['a.pace@justrebe.com', 'hello@justrebe.com'],
          reply_to: email,
          subject: `NEW NAESP ORDER — ${first_name} ${last_name} · ${school_name}`,
          text:
`A new NAESP purchase order was just submitted.

PURCHASER
  Name:          ${first_name} ${last_name}
  Title:         ${row.title || '(not given)'}
  Email:         ${email}
  Phone:         ${row.phone || '(not given)'}

SCHOOL
  Name:          ${school_name}
  District:      ${row.district || '(not given)'}
  Grade levels:  ${row.grade_levels || '(not given)'}
  # classrooms:  ${row.num_classrooms || '(not given)'}
  Address:       ${row.billing_address || '(not given)'}
                 ${row.city || ''} ${row.state || ''} ${row.zip || ''}
  PO #:          ${row.purchase_order_number || '(not given)'}

PACKAGE(S) ORDERED
${productLines}

PAYMENT METHOD
  ${paymentLine}

SIGNATURE
  Typed name:    ${signature_name}
  Date:          ${signed_date}

SUBMISSION META
  IP:            ${ip || '(unknown)'}
  Submitted:     ${new Date().toISOString()}

Row saved to Supabase (naesp_orders).
Kit tagged as: ReBe Ed — Lead + NAESP · 2026 + NAESP · Order Submitted.
Auto-response has already been sent to ${email}.

— ReBe Ed / NAESP order form`,
        }),
      }).catch((e) => console.error('NAESP order admin email failed:', e));
    }

    return res.status(200).json({ ok: true, id: inserted && inserted.id });
  } catch (err) {
    console.error('naesp-order failed:', err);
    return res.status(500).json({ error: 'Save failed', detail: String(err && err.message || err) });
  }
}
