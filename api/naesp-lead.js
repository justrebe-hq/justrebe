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
  thrive:    'Thrive — Educator Wellness ($5,000/school)',
  flourish:  'Flourish — K-2 Health Boosts + 3-5 free pilot ($250/teacher · $3,000/school rate)',
  premiere:  'Premiere — Literacy Residency Pilot ($5,000/school)',
  transform: 'Transform — Complete Package ★ ($10,500/school, save $3,000)',
  action:    '*Action — ReBe ReFresh Live add-on (+$300/educator)',
};

// Prices used to build Stripe line items server-side. MUST MATCH the frontend
// PRICES map in NAESP-order-form.html or totals will disagree.
const PRODUCT_PRICES = {
  thrive:    { amount: 5000,  label: 'Thrive — Educator Wellness (up to 15 educators)' },
  flourish:  { amount: 250,   label: 'Flourish — K-2 Health Boosts (+ free 3-5 pilot)',   qtyKey: 'qty_flourish', unitLabel: 'teachers', schoolRateAt: 15, schoolRatePerUnit: 200 },
  premiere:  { amount: 5000,  label: 'Premiere — Literacy Residency Pilot (up to 15 classrooms)' },
  transform: { amount: 10500, label: 'Transform — Complete Package ★ (up to 15 educators + 15 classrooms)' },
  action:    { amount: 300,   label: '*Action — ReBe ReFresh Live (add-on)',              qtyKey: 'qty_action',   unitLabel: 'educators' },
};

// Build Stripe line-items from selected products + optional quantities.
// Flourish honors the 15+ school rate override.
function buildStripeLineItems(products, quantities) {
  const items = [];
  let total = 0;
  const safeQ = quantities || {};
  for (const pid of products) {
    const p = PRODUCT_PRICES[pid];
    if (!p) continue;
    let qty = 1;
    let unitAmount = p.amount;
    let name = p.label;
    if (p.qtyKey) {
      qty = Math.max(1, parseInt(safeQ[p.qtyKey], 10) || 1);
      if (p.schoolRateAt && qty >= p.schoolRateAt && p.schoolRatePerUnit) {
        // Discounted per-unit rate when quantity crosses the threshold.
        unitAmount = p.schoolRatePerUnit;
        name = p.label + ' — school rate ($' + p.schoolRatePerUnit + '/' + (p.unitLabel || 'seat').replace(/s$/, '') + ')';
      } else {
        name = p.label + ' — per ' + (p.unitLabel || 'seat').replace(/s$/, '');
      }
    }
    items.push({ name, unit_amount: unitAmount * 100, quantity: qty });
    total += unitAmount * qty;
  }
  return { items, total };
}

// Create a Stripe Checkout Session and return the hosted URL. Throws on failure.
async function createNaespCheckoutSession(order) {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) throw new Error('STRIPE_SECRET_KEY env var not set');

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('customer_email', order.email);
  params.append('billing_address_collection', 'auto');
  params.append('phone_number_collection[enabled]', 'true');

  const baseUrl = (process.env.SITE_URL || 'https://www.justrebe.com').replace(/\/+$/, '');
  params.append('success_url', `${baseUrl}/NAESP-thank-you?paid=success&session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${baseUrl}/NAESP-order-form.html?cancelled=1`);

  order.line_items.forEach((it, idx) => {
    params.append(`line_items[${idx}][price_data][currency]`, 'usd');
    params.append(`line_items[${idx}][price_data][product_data][name]`, it.name);
    params.append(`line_items[${idx}][price_data][unit_amount]`, String(it.unit_amount));
    params.append(`line_items[${idx}][quantity]`, String(it.quantity));
  });

  // Metadata travels to Stripe → visible in dashboard + webhook payloads
  params.append('metadata[kind]', 'naesp');
  params.append('metadata[school_name]', (order.school_name || '').slice(0, 490));
  if (order.district) params.append('metadata[district]', order.district.slice(0, 490));
  params.append('metadata[buyer_name]', ((order.first_name || '') + ' ' + (order.last_name || '')).trim().slice(0, 490));
  if (order.phone) params.append('metadata[buyer_phone]', order.phone.slice(0, 490));
  params.append('metadata[products]', (order.products || []).join(','));
  if (order.naesp_order_id) params.append('metadata[naesp_order_id]', String(order.naesp_order_id));

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!r.ok) {
    const detail = await r.text();
    console.error(`Stripe error ${r.status}:`, detail);
    throw new Error('Stripe rejected the request');
  }
  return await r.json();
}

// Customize the buyer's confirmation email based on their payment method.
function paymentMethodBlurb(method) {
  switch (method) {
    case 'card':  return "You'll be redirected to Stripe to complete your payment securely. Once payment completes, Stripe emails you a receipt automatically and a member of our team follows up within one business day with onboarding details.";
    case 'po':    return "We'll send you a formal invoice within one business day with Net 30 terms. Once your PO is processed, we'll schedule your onboarding call.";
    case 'check': return "Please make your check payable to JustReBe LLC and mail to the address in the footer. We'll begin onboarding as soon as we receive payment.";
    case 'ach':   return "We'll email you our ACH / wire transfer details within one business day. Onboarding begins once payment clears.";
    default:      return "We'll follow up shortly to confirm your preferred payment method and next steps.";
  }
}
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

  // Route by form_type:
  //   'naesp_order'          -> purchase-order (PO/check/net-30 path)
  //   'naesp_post_purchase'  -> post-Stripe-payment school-info form
  //   else                   -> original lead/contact form
  if (body.form_type === 'naesp_order') {
    return handleOrder(body, req, res);
  }
  if (body.form_type === 'naesp_post_purchase') {
    return handlePostPurchase(body, req, res);
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

      // Purchaser auto-response (message body varies by payment method)
      const isCard = row.payment_method === 'card';
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: email,
          subject: isCard
            ? `Your ReBe Ed order — completing payment, ${first_name}`
            : `Thank you for your ReBe Ed order, ${first_name}`,
          text:
`Hi ${first_name},

${isCard
  ? "Thank you for your ReBe Ed order. You've been redirected to Stripe to complete payment. Once payment completes, Stripe emails you a receipt automatically and a member of our team follows up within one business day with onboarding details."
  : "Thank you for submitting your ReBe Ed order. We've received it."}

${paymentMethodBlurb(row.payment_method)}

Here's a summary of what you submitted:

  School / Org:  ${school_name}${row.district ? '\n  District:      ' + row.district : ''}

  Package(s):
${productLines}

  Payment method: ${paymentLine}

If you have questions in the meantime, just reply to this email or reach out directly:
  Valerie Ellery  — v.ellery@justrebe.com
  Abbey Pace      — a.pace@justrebe.com

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

    // Card path — build line items and create a Stripe Checkout Session.
    // The frontend redirects the user to the returned URL.
    let checkout_url = null;
    if (row.payment_method === 'card') {
      try {
        const { items } = buildStripeLineItems(products, body.quantities || {});
        if (!items.length) throw new Error('No valid products to charge');
        const session = await createNaespCheckoutSession({
          email,
          first_name,
          last_name,
          phone: row.phone,
          school_name,
          district: row.district,
          products,
          line_items: items,
          naesp_order_id: inserted && inserted.id,
        });
        checkout_url = session && session.url;
        if (!checkout_url) throw new Error('Stripe session missing url');
      } catch (e) {
        console.error('NAESP Stripe session creation failed:', e);
        // Order is already saved + emails sent; just return without a URL and
        // let the frontend show a graceful "we'll follow up" message.
        return res.status(200).json({
          ok: true,
          id: inserted && inserted.id,
          checkout_url: null,
          checkout_error: "We couldn't open Stripe checkout right now — your order was received and we'll email you a payment link within one business day.",
        });
      }
    }

    return res.status(200).json({
      ok: true,
      id: inserted && inserted.id,
      checkout_url: checkout_url,
    });
  } catch (err) {
    console.error('naesp-order failed:', err);
    return res.status(500).json({ error: 'Save failed', detail: String(err && err.message || err) });
  }
}

// ============================================================================
// Called when form_type === 'naesp_post_purchase' (from NAESP-thank-you.html).
// This runs AFTER a buyer already paid via Stripe. We just need to capture
// the school details so we can onboard them.
// - Tries to save to naesp_orders (best-effort; failure does NOT block emails)
// - Subscribes to Kit with card-payment tags (best-effort)
// - Auto-response to buyer via Resend
// - Notification to v.ellery@justrebe.com, cc a.pace@ + hello@
// ============================================================================
const STRIPE_PRODUCT_LABEL = {
  thrive:    'Thrive — Educator Wellness Package',
  flourish:  'Flourish — K-2 Health Boosts (+ 3-5 pilot)',
  premiere:  'Premiere — Literacy Residency Pilot',
  transform: 'Transform — Complete Package ★',
};

async function handlePostPurchase(body, req, res) {
  const first_name = (body.first_name || '').toString().trim();
  const last_name  = (body.last_name  || '').toString().trim();
  const email      = (body.email      || '').toString().trim().toLowerCase();
  const phone      = (body.phone      || '').toString().trim();
  const title      = (body.title      || '').toString().trim();
  const school_name = (body.school_name || '').toString().trim();
  const district    = (body.district    || '').toString().trim();
  const state       = (body.state       || '').toString().trim();
  const grade_levels  = (body.grade_levels  || '').toString().trim();
  const num_classrooms = (body.num_classrooms || '').toString().trim();
  const start_date  = (body.start_date  || '').toString().trim();
  const notes       = (body.notes       || '').toString().trim();
  const stripe_product = (body.stripe_product || 'unknown').toString().trim().toLowerCase();

  const missing = [];
  if (!first_name) missing.push('first_name');
  if (!last_name)  missing.push('last_name');
  if (!email)      missing.push('email');
  if (!phone)      missing.push('phone');
  if (!title)      missing.push('title');
  if (!school_name) missing.push('school_name');
  if (!state)       missing.push('state');
  if (!grade_levels)  missing.push('grade_levels');
  if (!num_classrooms) missing.push('num_classrooms');
  if (!start_date)  missing.push('start_date');
  if (missing.length) {
    return res.status(400).json({ error: 'Missing required fields', required: missing });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const ipHeader = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  const ip = (Array.isArray(ipHeader) ? ipHeader[0] : String(ipHeader)).split(',')[0].trim() || null;
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 500) || null;
  const productLabel = STRIPE_PRODUCT_LABEL[stripe_product] || stripe_product;

  // 1) Best-effort Supabase save (does NOT block emails)
  let supabaseId = null;
  try {
    const url = supabaseBaseUrl();
    const key = supabaseKey();
    const row = {
      first_name, last_name, title: title || null, phone: phone || null, email,
      school_name, district: district || null, state: state || null,
      grade_levels: grade_levels || null, num_classrooms: num_classrooms || null,
      products: [stripe_product],
      payment_method: 'stripe_card',
      signature_name: `${first_name} ${last_name}`,
      signed_date: new Date().toISOString().slice(0, 10),
      source: (body.source || 'NAESP post-purchase form').toString().trim(),
      ip_address: ip, user_agent: userAgent,
    };
    const r = await fetch(`${url}/rest/v1/naesp_orders`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    if (r.ok) {
      const rows = await r.json();
      supabaseId = (rows && rows[0] && rows[0].id) || null;
    } else {
      const detail = await r.text();
      console.error(`Supabase naesp_orders (post-purchase) ${r.status}:`, detail);
    }
  } catch (e) {
    console.error('Supabase post-purchase save error:', e);
  }

  // 2) Best-effort Kit tag
  try {
    await kitSubscribe({
      email, first_name,
      tags: ['ReBe — All', 'ReBe Ed — Lead', 'NAESP · 2026', 'NAESP · Card Payment'],
    });
  } catch (e) {
    console.error('Kit subscribe (post-purchase):', e);
  }

  // 3) Emails via Resend (auto-response + admin notification)
  if (process.env.RESEND_API_KEY) {
    const fromAddr = process.env.NOTIFY_FROM || 'ReBe Ed <hello@justrebe.com>';
    const resendKey = process.env.RESEND_API_KEY;

    const detailBlock =
`  Product:        ${productLabel}
  School / Org:   ${school_name}${district ? '\n  District:       ' + district : ''}
  State:          ${state}
  Grade band(s):  ${grade_levels}
  Classrooms:     ${num_classrooms}
  Start date:     ${start_date}
  Contact:        ${first_name} ${last_name}${title ? ' (' + title + ')' : ''}
  Phone:          ${phone}
  Email:          ${email}${notes ? '\n  Notes:          ' + notes : ''}`;

    // Buyer confirmation
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddr,
        to: email,
        subject: `You're all set, ${first_name} — ReBe Ed onboarding next steps`,
        text:
`Hi ${first_name},

Thanks for completing your school details for ${school_name}. Your ${productLabel} order is confirmed.

Here's what happens next:
  1. A member of our team will reach out within one business day to schedule your onboarding call.
  2. On that call we'll confirm your start date, walk through what's included, and answer any questions.
  3. You'll receive access instructions and any relevant materials before your start date.

Your order summary:
${detailBlock}

If you need to reach us before we reach out, reply to this email or write to hello@justrebe.com.

Better me. Better we.

— The ReBe Ed Team
JustReBe, LLC
`,
      }),
    }).catch((e) => console.error('Resend buyer email error:', e));

    // Admin notification
    const notifyTo = ['v.ellery@justrebe.com'];
    const notifyCc = ['a.pace@justrebe.com', 'hello@justrebe.com'];
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddr,
        to: notifyTo,
        cc: notifyCc,
        reply_to: email,
        subject: `[NAESP · Paid] ${productLabel} — ${school_name}`,
        text:
`A NAESP buyer has completed their post-purchase school-info form.

${detailBlock}

${supabaseId ? 'Supabase row id: ' + supabaseId : 'NOTE: Supabase save failed — details are captured in this email only.'}
Submitted from: ${ip || 'unknown IP'}
`,
      }),
    }).catch((e) => console.error('Resend admin email error:', e));
  } else {
    console.error('RESEND_API_KEY missing — post-purchase emails not sent');
  }

  return res.status(200).json({ ok: true, id: supabaseId });
}
