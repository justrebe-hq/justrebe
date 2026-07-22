// api/create-checkout-session.js — Vercel serverless function
//
// Supports BOTH modes of Stripe Checkout:
//
//   1. HOSTED (legacy / existing flow used by the 1:1 form):
//      ui_mode omitted or 'hosted'. Returns `url` (Stripe-hosted page).
//      Frontend redirects to it. Requires success_url + cancel_url.
//
//   2. EMBEDDED (new flow used by /refresh-cohort-11am and -8pm):
//      ui_mode = 'embedded'. Returns `client_secret` (for Stripe.js
//      embedded checkout) + `publishable_key` (so the frontend can
//      initialize Stripe.js without hard-coding the pk). Requires
//      `return_url` (where to send the user after payment).
//
// Webhook (api/stripe-webhook.js) handles BOTH flows:
//   - If session.metadata.signup_id exists → UPDATE that row
//   - Otherwise (embedded cohort flow) → CREATE a new row from session data
//
// Required env vars (Vercel → Settings → Environment Variables):
//   STRIPE_SECRET_KEY        — sk_live_... or sk_test_...
//   STRIPE_PUBLISHABLE_KEY   — pk_live_... or pk_test_... (only needed for embedded mode)
//
// Expected request body (POST, application/json):
//   {
//     "kind":          "cohort" | "private",
//     "signup_id":     uuid (optional — required only for hosted/pre-create flow),
//     "customer_email": "buyer@example.com" (optional in embedded; Stripe collects),
//     "customer_name":  "Full Name" (optional),
//     "amount_cents":   30000,
//     "description":    "ReBe ReFresh · 5-Week Cohort (11 AM ET)",
//     "ui_mode":        "embedded" | "hosted" (default: "hosted"),
//     "return_url":     "https://justrebe.com/thank-you-cohort.html?slot=11am" (embedded only),
//     "success_url":    "https://justrebe.com/thank-you-cohort.html" (hosted only),
//     "cancel_url":     "https://justrebe.com/refresh-cohort.html" (hosted only),
//     "slot":           "11am" | "8pm" (cohort only; stored in metadata)
//   }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY env var not set');
    return res.status(500).json({ error: 'Stripe not configured (missing STRIPE_SECRET_KEY)' });
  }

  const body = req.body || {};
  const {
    kind,
    signup_id,
    customer_email,
    customer_name,
    amount_cents,
    description,
    success_url,
    cancel_url,
    return_url,
    referral_code,
    ui_mode,
    slot,
  } = body;

  const uiMode = ui_mode === 'embedded' ? 'embedded' : 'hosted';

  // Basic validation
  if (!kind || !['cohort', 'private', 'event'].includes(kind)) {
    return res.status(400).json({ error: "Invalid 'kind' — must be 'cohort', 'private', or 'event'" });
  }
  if (!amount_cents || typeof amount_cents !== 'number' || amount_cents < 50) {
    return res.status(400).json({ error: "Invalid 'amount_cents' (must be a number >= 50 cents)" });
  }
  if (!description) return res.status(400).json({ error: "Missing 'description'" });

  if (uiMode === 'embedded') {
    if (!return_url) return res.status(400).json({ error: "Missing 'return_url' (required for embedded mode)" });
  } else {
    // Hosted mode: signup_id + customer_email are OPTIONAL now.
    // When missing, the Stripe webhook creates a fresh refresh_signups
    // row from session data — same path embedded mode uses.
    if (!success_url) return res.status(400).json({ error: "Missing 'success_url'" });
    if (!cancel_url) return res.status(400).json({ error: "Missing 'cancel_url'" });
  }

  // Build Stripe Checkout Session params
  const params = new URLSearchParams();
  params.append('mode', 'payment');

  if (uiMode === 'embedded') {
    // Note: Stripe renamed 'embedded' to 'embedded_page' in their API,
    // but the JS SDK method is still stripe.initEmbeddedCheckout().
    params.append('ui_mode', 'embedded_page');
    params.append('return_url', return_url + (return_url.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}');
    // In embedded mode, Stripe collects email itself; we don't pre-fill.
    // We DO collect phone since we want it for SMS reminders.
    params.append('phone_number_collection[enabled]', 'true');
    // Force Stripe to create a Customer object so the cardholder's name lands
    // in session.customer_details.name (otherwise it stays empty).
    params.append('customer_creation', 'always');
    // Ask Stripe to collect billing address — needed to populate the name field reliably
    params.append('billing_address_collection', 'auto');
  } else {
    if (customer_email) params.append('customer_email', customer_email);
    if (signup_id) params.append('client_reference_id', signup_id);
    params.append('success_url', success_url + (success_url.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', cancel_url);
    // When the caller didn't pre-create a signup row, mirror the embedded
    // flow's collection settings so Stripe gathers everything the webhook
    // needs to create the refresh_signups row from session data.
    if (!signup_id) {
      params.append('phone_number_collection[enabled]', 'true');
      params.append('customer_creation', 'always');
      params.append('billing_address_collection', 'auto');
    }
  }

  // Line item
  params.append('line_items[0][price_data][currency]', 'usd');
  params.append('line_items[0][price_data][product_data][name]', description);
  params.append('line_items[0][price_data][unit_amount]', String(amount_cents));
  params.append('line_items[0][quantity]', '1');

  // Metadata — travels to the webhook so it knows what was bought
  params.append('metadata[kind]', kind);
  if (signup_id) params.append('metadata[signup_id]', signup_id);
  if (customer_name) params.append('metadata[customer_name]', customer_name);
  if (referral_code) params.append('metadata[referral_code]', referral_code);
  if (slot) params.append('metadata[slot]', slot);

  try {
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
      return res.status(500).json({ error: 'Stripe rejected the request', detail });
    }

    const session = await r.json();

    if (uiMode === 'embedded') {
      const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
      if (!publishableKey) {
        console.error('STRIPE_PUBLISHABLE_KEY env var not set (required for embedded mode)');
        return res.status(500).json({ error: 'Stripe publishable key not configured' });
      }
      return res.status(200).json({
        id: session.id,
        client_secret: session.client_secret,
        publishable_key: publishableKey,
      });
    }

    return res.status(200).json({
      id: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session', detail: String(err && err.message || err) });
  }
};
