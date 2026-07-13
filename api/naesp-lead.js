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
const {
  renderEmail,
  esc,
  p: htmlP,
  h: htmlH,
  eyebrow: htmlEyebrow,
  callout: htmlCallout,
  button: htmlButton,
  detailRows: htmlDetailRows,
  list: htmlList,
  divider: htmlDivider,
} = require('./_email.js');

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
  thrive:    'Thrive — Lights + Camera package ($4,000 conference · reg $6,000)',
  flourish:  'Flourish — K-2 Health Boosts per grade + FREE 3-5 pilot included ($250/educator · 1-year license)',
  premiere:  'Literacy Residency Pilot ($8,000 conference · reg $10,000/school)',
  transform: 'Transform — Educator + Student Wellness ★ ($11,000 conference · reg $16,000 · save $5,000)',
  action:    'Action — ReBe ReFresh Live add-on (+$300/educator)',
};

// Conference prices for Stripe line items. MUST MATCH the frontend PRICES
// map in NAESP-order-form.html or the total won't reconcile at checkout.
const PRODUCT_PRICES = {
  thrive:    { amount: 4000,  label: 'Thrive — Lights + Camera package' },
  flourish:  { amount: 250,   label: 'Flourish — K-2 Health Boosts per grade (+ FREE 3-5 pilot, 1-year license)', qtyKey: 'qty_flourish', unitLabel: 'educators' },
  premiere:  { amount: 8000,  label: 'Literacy Residency Pilot (per school)' },
  transform: { amount: 11000, label: 'Transform — Educator + Student Wellness ★ (per school)' },
  action:    { amount: 300,   label: 'Action — ReBe ReFresh Live (add-on)', qtyKey: 'qty_action', unitLabel: 'educators' },
};

// Build Stripe line-items from selected products + optional quantities.
function buildStripeLineItems(products, quantities) {
  const items = [];
  let total = 0;
  const safeQ = quantities || {};
  for (const pid of products) {
    const p = PRODUCT_PRICES[pid];
    if (!p) continue;
    let qty = 1;
    let name = p.label;
    if (p.qtyKey) {
      qty = Math.max(1, parseInt(safeQ[p.qtyKey], 10) || 1);
      name = p.label + ' — per ' + (p.unitLabel || 'seat').replace(/s$/, '');
    }
    items.push({ name, unit_amount: p.amount * 100, quantity: qty });
    total += p.amount * qty;
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

// Mailing address for check payments — used in the buyer confirmation email.
const CHECK_MAILING_ADDRESS = '13118 State Rd 64 E., Suite 362, Bradenton, FL 34212';

// Customize the buyer's confirmation email based on their payment method.
// Card gets a payment link injected separately (see handleOrder).
function paymentMethodBlurb(method) {
  switch (method) {
    case 'card':  return "Your secure payment link is included below. Click it to complete payment on our secure payment page — you'll receive a receipt automatically once payment completes, and our team follows up within one business day with onboarding details.";
    case 'po':    return "We'll send you a formal invoice within one business day with Net 30 terms. Once your PO is processed, we'll schedule your onboarding call.";
    case 'check': return "Please make your check payable to JustReBe LLC and mail to:\n\n  " + CHECK_MAILING_ADDRESS + "\n\nWe'll begin onboarding as soon as we receive payment.";
    default:      return "We'll follow up shortly to confirm your preferred payment method and next steps.";
  }
}
const PAYMENT_LABEL = {
  po:    'Purchase Order (Net 30 invoice)',
  card:  'Credit Card (secure payment link will be emailed)',
  check: 'Check (payable to JustReBe LLC · mail to ' + CHECK_MAILING_ADDRESS + ')',
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
    // Fire both emails and AWAIT them — Vercel Node freezes after the
    // response is sent, so any unawaited fetch may be terminated mid-flight.
    if (process.env.RESEND_API_KEY) {
      const fromAddr = 'ReBe Ed <hello@justrebe.com>';
      const adminAddr = process.env.NOTIFY_ADMIN || 'hello@justrebe.com';
      const resendKey = process.env.RESEND_API_KEY;

      const leadAutoResponseSubject = `Thanks for stopping by, ${first_name} — here's what's next`;
      const leadAutoResponseText =
`Hi ${first_name},

Thanks for your interest in ReBe Ed. We're glad you stopped by.

Here's the offering details and pricing you asked to see:
https://www.justrebe.com/NAESP-product

Three ways to bring ReBe Ed to your school:
  1. Thrive — Educator Wellness (Lights + Camera package)
  2. Flourish — Student Wellness (K-2 Health Boosts + FREE 3-5 pilot, or full Literacy Residency Pilot)
  3. Transform — Complete Package (Thrive + Flourish, conference-only pricing)

Someone from our team will reach out this week to answer any questions and set up a 20-minute call. If you can't wait, just reply to this email.

Warmly,
The ReBe Ed team
hello@justrebe.com
www.justrebe.com/education`;
      const leadAutoResponseHtml = renderEmail({
        preheader: `Thanks ${first_name} — here's the offerings link and what's next.`,
        body:
          htmlEyebrow(`Thanks for stopping by`) +
          htmlH(`Great to meet you, ${esc(first_name)}.`) +
          htmlP(`Thanks for your interest in ReBe Ed. Here's the offering details and pricing you asked to see:`) +
          htmlButton('See offering details & pricing', 'https://www.justrebe.com/NAESP-product') +
          htmlP(`<strong>Three ways to bring ReBe Ed to your school:</strong>`) +
          htmlList([
            `<strong>Thrive</strong> &mdash; Educator Wellness (Lights + Camera package)`,
            `<strong>Flourish</strong> &mdash; Student Wellness (K-2 Health Boosts + FREE 3-5 pilot, or full Literacy Residency Pilot)`,
            `<strong>Transform</strong> &mdash; Complete Package (Thrive + Flourish, conference-only pricing)`,
          ]) +
          htmlP(`Someone from our team will reach out this week to answer any questions and set up a 20-minute call. If you can't wait, just reply to this email.`) +
          htmlDivider() +
          htmlP(`Warmly,<br><strong>The ReBe Ed team</strong>`, { size: '14px' }),
      });
      const leadAutoResponse = fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: email,
          subject: leadAutoResponseSubject,
          text: leadAutoResponseText,
          html: leadAutoResponseHtml,
        }),
      }).catch((e) => console.error('NAESP lead auto-response failed:', e));

      const adminSubmittedAt = new Date().toISOString();
      const adminNotifySubject = `New NAESP lead — ${first_name} ${last_name} (${school_organization})`;
      const adminNotifyText =
`A new NAESP lead just came through.

  Name:          ${first_name} ${last_name}
  Email:         ${email}
  School / Org:  ${school_organization}
  Source:        ${source}
  IP:            ${ip || '(unknown)'}
  Submitted:     ${adminSubmittedAt}

They've been forwarded to /NAESP-product.html and Kit-tagged as
ReBe Ed — Lead + NAESP · 2026. An auto-response has already been sent.

— ReBe Ed / NAESP form`;
      const adminNotifyHtml = renderEmail({
        preheader: `${first_name} ${last_name} — ${school_organization}`,
        body:
          htmlEyebrow('New NAESP lead') +
          htmlH(`${esc(first_name)} ${esc(last_name)}`) +
          htmlP(`A new NAESP lead just came through. Details below.`) +
          htmlDetailRows([
            ['Name', `${first_name} ${last_name}`],
            ['Email', email],
            ['School / Org', school_organization],
            ['Source', source],
            ['IP', ip || '(unknown)'],
            ['Submitted', adminSubmittedAt],
          ]) +
          htmlCallout(
            `Kit-tagged as <strong>ReBe Ed &mdash; Lead</strong> + <strong>NAESP &middot; 2026</strong>. An auto-response has already been sent.`,
            { accent: '#7D0AAB' }
          ),
      });
      const adminNotify = fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: adminAddr,
          reply_to: email,
          subject: adminNotifySubject,
          text: adminNotifyText,
          html: adminNotifyHtml,
        }),
      }).catch((e) => console.error('NAESP admin email failed:', e));

      await Promise.allSettled([leadAutoResponse, adminNotify]);
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
  let products = Array.isArray(body.products) ? body.products.filter(Boolean) : [];
  // Backend guard for Transform exclusivity — mirrors the frontend UX so a
  // stale tab or JS-disabled browser can't submit Transform + Thrive/Flourish/Premiere
  // and get charged for the overlap.
  if (products.includes('transform')) {
    products = products.filter((p) => !['thrive', 'flourish', 'premiere'].includes(p));
  }

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

    // Card path — build Stripe Checkout Session FIRST so we can include the
    // payment link in the buyer's confirmation email below.
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
        if (!checkout_url) throw new Error('Payment session missing url');
      } catch (e) {
        console.error('NAESP payment session creation failed:', e);
        // Fall through — emails still fire; buyer gets a manual follow-up.
      }
    }

    // Resend: auto-response + admin notification
    if (process.env.RESEND_API_KEY) {
      const fromAddr = 'ReBe Ed <hello@justrebe.com>';
      const resendKey = process.env.RESEND_API_KEY;

      const productLines = products.map((p) => `  • ${PRODUCT_LABEL[p] || p}`).join('\n');
      const paymentLine = PAYMENT_LABEL[row.payment_method] || row.payment_method || '(not selected)';
      const isCard = row.payment_method === 'card';
      const paymentLinkBlock = (isCard && checkout_url)
        ? `\n\n  Your secure payment link:\n  ${checkout_url}\n`
        : (isCard ? `\n\n  We hit a temporary issue generating your payment link — a member of our team will email one to you within a few hours.\n` : '');

      const orderProductListHtml = htmlList(products.map((pid) => esc(PRODUCT_LABEL[pid] || pid)));
      const orderAutoResponseSubject = isCard
        ? `Your ReBe Ed order — payment link inside, ${first_name}`
        : `Thank you for your ReBe Ed order, ${first_name}`;
      const orderAutoResponseText =
`Hi ${first_name},

Thank you for submitting your ReBe Ed order. We've received it.

${paymentMethodBlurb(row.payment_method)}${paymentLinkBlock}

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
www.justrebe.com/education`;
      const paymentBlurbHtml = esc(paymentMethodBlurb(row.payment_method)).replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>');
      const cardPaymentBlock = isCard && checkout_url
        ? htmlP(`Ready to complete payment now? Click the button below to be taken to our secure Stripe checkout.`) +
          htmlButton('Complete payment', checkout_url)
        : (isCard
          ? htmlCallout(`We hit a temporary issue generating your payment link &mdash; a member of our team will email one to you within a few hours.`, { bg: '#FFF7EA', border: '#FCE1B3', accent: '#e5a708' })
          : '');
      const orderAutoResponseHtml = renderEmail({
        preheader: isCard ? `Order received — your secure payment link is inside.` : `Order received — thank you for choosing ReBe Ed.`,
        body:
          htmlEyebrow('Order received') +
          htmlH(`Thank you, ${esc(first_name)}.`) +
          htmlP(`We've received your ReBe Ed order. Here's what happens next:`) +
          htmlCallout(paymentBlurbHtml, { bg: '#F5F9FC', border: '#DBE4EC', accent: '#034E64' }) +
          cardPaymentBlock +
          htmlP(`<strong>Your order summary:</strong>`) +
          htmlDetailRows([
            ['School / Org', school_name],
            ['District', row.district || ''],
            ['Payment method', paymentLine],
          ]) +
          htmlP(`<strong>Package(s):</strong>`, { margin: '10px 0 4px' }) +
          orderProductListHtml +
          htmlDivider() +
          htmlP(`Questions? Reply to this email or reach out directly:<br>
Valerie Ellery &mdash; <a href="mailto:v.ellery@justrebe.com" style="color:#034E64;font-weight:700;">v.ellery@justrebe.com</a><br>
Abbey Pace &mdash; <a href="mailto:a.pace@justrebe.com" style="color:#034E64;font-weight:700;">a.pace@justrebe.com</a>`, { size: '14px' }) +
          htmlP(`Thank you for bringing ReBe Ed to your students.`, { color: '#1A1A1A' }) +
          htmlP(`Warmly,<br><strong>The ReBe Ed team</strong>`, { size: '14px' }),
      });
      const orderAutoResponse = fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: email,
          subject: orderAutoResponseSubject,
          text: orderAutoResponseText,
          html: orderAutoResponseHtml,
        }),
      }).catch((e) => console.error('NAESP order auto-response failed:', e));

      const orderSubmittedAt = new Date().toISOString();
      const orderAdminSubject = `NEW NAESP ORDER — ${first_name} ${last_name} · ${school_name}`;
      const orderAdminText =
`A new NAESP order was just submitted.

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
  ${paymentLine}${isCard && checkout_url ? '\n  Payment link: ' + checkout_url : ''}${isCard && !checkout_url ? '\n  ⚠ Payment link generation FAILED — please create one manually in Stripe and email the buyer.' : ''}

SIGNATURE
  Typed name:    ${signature_name}
  Date:          ${signed_date}

SUBMISSION META
  IP:            ${ip || '(unknown)'}
  Submitted:     ${orderSubmittedAt}

Row saved to Supabase (naesp_orders).
Kit tagged as: ReBe Ed — Lead + NAESP · 2026 + NAESP · Order Submitted.
Auto-response has already been sent to ${email}.

— ReBe Ed / NAESP order form`;
      const paymentAdminBlock = isCard
        ? (checkout_url
          ? htmlCallout(`<strong>Payment link:</strong> <a href="${esc(checkout_url)}" style="color:#034E64;font-weight:700;">${esc(checkout_url)}</a>`, { bg: '#F0F7FA', border: '#B5D2DC', accent: '#034E64' })
          : htmlCallout(`&#9888; <strong>Payment link generation FAILED</strong> &mdash; please create one manually in Stripe and email the buyer.`, { bg: '#FCEDED', border: '#F0C4C4', accent: '#B02929' }))
        : '';
      const orderAdminHtml = renderEmail({
        preheader: `${first_name} ${last_name} · ${school_name} · ${paymentLine}`,
        body:
          htmlEyebrow('New NAESP order') +
          htmlH(`${esc(first_name)} ${esc(last_name)}`) +
          htmlP(`<strong>${esc(school_name)}</strong>${row.district ? ' &middot; ' + esc(row.district) : ''}`) +
          paymentAdminBlock +
          htmlP(`<strong>Purchaser</strong>`, { margin: '18px 0 4px', color: '#7D0AAB' }) +
          htmlDetailRows([
            ['Name', `${first_name} ${last_name}`],
            ['Title', row.title],
            ['Email', email],
            ['Phone', row.phone],
          ]) +
          htmlP(`<strong>School</strong>`, { margin: '6px 0 4px', color: '#7D0AAB' }) +
          htmlDetailRows([
            ['Name', school_name],
            ['District', row.district],
            ['Grade levels', row.grade_levels],
            ['# classrooms', row.num_classrooms],
            ['Address', row.billing_address],
            ['City / State / Zip', [row.city, row.state, row.zip].filter(Boolean).join(' ')],
            ['PO #', row.purchase_order_number],
          ]) +
          htmlP(`<strong>Package(s) ordered</strong>`, { margin: '6px 0 4px', color: '#7D0AAB' }) +
          orderProductListHtml +
          htmlP(`<strong>Payment method:</strong> ${esc(paymentLine)}`, { margin: '10px 0 14px' }) +
          htmlP(`<strong>Signature</strong>`, { margin: '6px 0 4px', color: '#7D0AAB' }) +
          htmlDetailRows([
            ['Typed name', signature_name],
            ['Date', signed_date],
          ]) +
          htmlP(`<strong>Submission meta</strong>`, { margin: '6px 0 4px', color: '#7D0AAB' }) +
          htmlDetailRows([
            ['IP', ip || '(unknown)'],
            ['Submitted', orderSubmittedAt],
          ]) +
          htmlCallout(
            `Row saved to Supabase (<code>naesp_orders</code>). Kit tagged: <strong>ReBe Ed &mdash; Lead</strong>, <strong>NAESP &middot; 2026</strong>, <strong>NAESP &middot; Order Submitted</strong>. Auto-response has already been sent to ${esc(email)}.`,
            { bg: '#F5F9FC', border: '#DBE4EC', accent: '#034E64' }
          ),
      });
      const orderAdminNotify = fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: fromAddr,
          to: 'v.ellery@justrebe.com',
          cc: ['a.pace@justrebe.com', 'hello@justrebe.com'],
          reply_to: email,
          subject: orderAdminSubject,
          text: orderAdminText,
          html: orderAdminHtml,
        }),
      }).catch((e) => console.error('NAESP order admin email failed:', e));

      await Promise.allSettled([orderAutoResponse, orderAdminNotify]);
    }

    // Card path returns checkout_url so the frontend can send the buyer
    // straight to the secure payment link. The link is ALSO included in the
    // confirmation email above as a backup (in case they close the tab).
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
  premiere:  'Literacy Residency Pilot',
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
    const fromAddr = 'ReBe Ed <hello@justrebe.com>';
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

    const postDetailPairs = [
      ['Product', productLabel],
      ['School / Org', school_name],
      ['District', district],
      ['State', state],
      ['Grade band(s)', grade_levels],
      ['Classrooms', num_classrooms],
      ['Start date', start_date],
      ['Contact', `${first_name} ${last_name}${title ? ' (' + title + ')' : ''}`],
      ['Phone', phone],
      ['Email', email],
      ['Notes', notes],
    ];

    // Buyer confirmation
    const postBuyerSubject = `You're all set, ${first_name} — ReBe Ed onboarding next steps`;
    const postBuyerText =
`Hi ${first_name},

Thanks for completing your school details for ${school_name}. Your ${productLabel} order is confirmed.

We'll be in touch soon to walk you through next steps.

Your order summary:
${detailBlock}

If you need to reach us before we reach out, reply to this email or write to hello@justrebe.com.

Better me. Better we.

— The ReBe Ed Team
JustReBe, LLC
`;
    const postBuyerHtml = renderEmail({
      preheader: `You're all set — we'll be in touch soon.`,
      body:
        htmlEyebrow(`You're all set`) +
        htmlH(`Thank you, ${esc(first_name)}.`) +
        htmlP(`Thanks for completing your school details for <strong>${esc(school_name)}</strong>. Your <strong>${esc(productLabel)}</strong> order is confirmed.`) +
        htmlCallout(`We'll be in touch soon to walk you through next steps and answer any questions.`, { bg: '#F3FAEC', border: '#DEEBC7', accent: '#638D13' }) +
        htmlP(`<strong>Your order summary:</strong>`, { margin: '18px 0 4px' }) +
        htmlDetailRows(postDetailPairs) +
        htmlDivider() +
        htmlP(`If you need to reach us before we reach out, reply to this email or write to <a href="mailto:hello@justrebe.com" style="color:#034E64;font-weight:700;">hello@justrebe.com</a>.`, { size: '14px' }) +
        htmlP(`<em>Better me. Better we.</em>`, { color: '#7D0AAB', size: '15px' }) +
        htmlP(`&mdash; The ReBe Ed Team<br>JustReBe, LLC`, { size: '14px' }),
    });
    const postBuyerEmail = fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddr,
        to: email,
        subject: postBuyerSubject,
        text: postBuyerText,
        html: postBuyerHtml,
      }),
    }).catch((e) => console.error('Resend buyer email error:', e));

    // Admin notification
    const notifyTo = ['v.ellery@justrebe.com'];
    const notifyCc = ['a.pace@justrebe.com', 'hello@justrebe.com'];
    const postAdminSubject = `[NAESP · Paid] ${productLabel} — ${school_name}`;
    const postAdminText =
`A NAESP buyer has completed their post-purchase school-info form.

${detailBlock}

${supabaseId ? 'Supabase row id: ' + supabaseId : 'NOTE: Supabase save failed — details are captured in this email only.'}
Submitted from: ${ip || 'unknown IP'}
`;
    const postAdminHtml = renderEmail({
      preheader: `${first_name} ${last_name} · ${school_name} · ${productLabel}`,
      body:
        htmlEyebrow('NAESP · Paid') +
        htmlH(`${esc(first_name)} ${esc(last_name)}`) +
        htmlP(`<strong>${esc(productLabel)}</strong> &middot; <strong>${esc(school_name)}</strong>`) +
        htmlP(`A NAESP buyer has completed their post-purchase school-info form.`) +
        htmlDetailRows(postDetailPairs) +
        htmlCallout(
          supabaseId
            ? `Supabase row id: <code>${esc(supabaseId)}</code>. Submitted from: ${esc(ip || 'unknown IP')}.`
            : `<strong>NOTE:</strong> Supabase save failed &mdash; details are captured in this email only. Submitted from: ${esc(ip || 'unknown IP')}.`,
          supabaseId
            ? { bg: '#F5F9FC', border: '#DBE4EC', accent: '#034E64' }
            : { bg: '#FCEDED', border: '#F0C4C4', accent: '#B02929' }
        ),
    });
    const postAdminEmail = fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromAddr,
        to: notifyTo,
        cc: notifyCc,
        reply_to: email,
        subject: postAdminSubject,
        text: postAdminText,
        html: postAdminHtml,
      }),
    }).catch((e) => console.error('Resend admin email error:', e));

    await Promise.allSettled([postBuyerEmail, postAdminEmail]);
  } else {
    console.error('RESEND_API_KEY missing — post-purchase emails not sent');
  }

  return res.status(200).json({ ok: true, id: supabaseId });
}
