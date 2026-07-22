// api/stripe-webhook.js — Vercel serverless function
//
// Receives webhook events from Stripe. Verifies the signature, then
// (on a successful checkout.session.completed event) updates the
// matching Supabase row to status='paid'.
//
// Stripe → Dashboard → Developers → Webhooks → Add endpoint
//   URL:     https://justrebe.com/api/stripe-webhook
//   Events:  checkout.session.completed
//            customer.subscription.updated    (Studio: status + period-end sync)
//            customer.subscription.deleted    (Studio: mark cancelled)
//   Copy the "Signing secret" (whsec_...) into STRIPE_WEBHOOK_SECRET env var.
//
// Required env vars (Vercel → Settings → Environment Variables):
//   STRIPE_WEBHOOK_SECRET     — whsec_... from the webhook endpoint config
//   SUPABASE_URL              — https://YOUR_PROJECT.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — service_role key (NOT the anon key — this bypasses RLS)
//
// Stripe signature verification needs the RAW request body, not the
// parsed JSON, so we disable Vercel's default body parser below.

const crypto = require('crypto');
const { kitSubscribe } = require('./_kit.js');
const { createOpenPhoneContact } = require('./_openphone.js');
const { sendEventConfirmation } = require('./_eventmail.js');

// Tell Vercel to give us the raw body, not a parsed JSON object.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

// Read the raw request body as a Buffer.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Stripe signature verification.
// Header format: "t=TIMESTAMP,v1=SIGNATURE[,v1=...]"
// Signed payload: `${timestamp}.${rawBody}` HMAC-SHA256 with the secret.
// Tolerance window: 5 minutes (matches Stripe's recommendation).
function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader || typeof sigHeader !== 'string') return false;

  const parts = sigHeader.split(',').reduce((acc, kv) => {
    const [k, v] = kv.split('=');
    if (!acc[k]) acc[k] = [];
    acc[k].push(v);
    return acc;
  }, {});

  const timestamp = parts.t && parts.t[0];
  const signatures = parts.v1 || [];
  if (!timestamp || signatures.length === 0) return false;

  // Check timestamp freshness
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > toleranceSeconds) return false;

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Constant-time compare against any provided v1 signature
  return signatures.some((sig) => {
    try {
      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  });
}

// Strip whitespace and trailing slash, and remove any accidentally-included
// REST path component (e.g., "/rest/v1") so the resulting URL is well-formed.
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

// PATCH a Supabase row using the service-role key (bypasses RLS).
async function supabasePatch({ table, id, patch }) {
  const url = supabaseBaseUrl();
  const key = supabaseKey();
  const r = await fetch(`${url}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });

  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Supabase PATCH ${r.status}: ${detail}`);
  }
  return r.json();
}

// INSERT a Supabase row using the service-role key (bypasses RLS).
// Used by the embedded-cohort flow where the row is created from Stripe data
// (since no pre-checkout form ran to pre-create it).
async function supabaseInsert({ table, row }) {
  const url = supabaseBaseUrl();
  const key = supabaseKey();
  const r = await fetch(`${url}/rest/v1/${table}`, {
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
    throw new Error(`Supabase INSERT ${r.status}: ${detail}`);
  }
  return r.json();
}

// Handle Studio subscription lifecycle events. Maps Stripe subscription
// status to our simpler set — 'active' | 'past_due' | 'cancelled' — and
// keeps current_period_end + cancelled_at fresh so the admin view stays
// accurate as members renew, fail payment, or quit.
async function handleStudioSubscriptionEvent(event, res) {
  const sub = (event.data && event.data.object) || {};
  const subId = sub.id;
  if (!subId) {
    console.error('Subscription event missing id', event.type);
    return res.status(200).json({ ok: true, skipped: 'missing subscription id' });
  }

  // Stripe statuses: incomplete, incomplete_expired, trialing, active,
  // past_due, canceled, unpaid, paused.
  let ourStatus = null;
  if (event.type === 'customer.subscription.deleted' || sub.status === 'canceled') {
    ourStatus = 'cancelled';
  } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
    ourStatus = 'past_due';
  } else if (sub.status === 'active' || sub.status === 'trialing') {
    ourStatus = 'active';
  }
  // For incomplete/paused/etc. we leave status alone.

  const patch = {};
  if (ourStatus) patch.status = ourStatus;
  if (sub.canceled_at) {
    patch.cancelled_at = new Date(sub.canceled_at * 1000).toISOString();
  } else if (ourStatus === 'cancelled') {
    patch.cancelled_at = new Date().toISOString();
  }
  if (sub.current_period_end) {
    patch.current_period_end = new Date(sub.current_period_end * 1000).toISOString();
  }

  if (Object.keys(patch).length === 0) {
    return res.status(200).json({ ok: true, skipped: 'nothing to update', subId });
  }

  try {
    const url = supabaseBaseUrl();
    const key = supabaseKey();
    const r = await fetch(
      `${url}/rest/v1/studio_members?stripe_subscription_id=eq.${encodeURIComponent(subId)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(patch),
      }
    );
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`Supabase PATCH ${r.status}: ${detail}`);
    }
    const rows = await r.json();

    // rows.length === 0 means we don't have this subscription in our table.
    // Not an error — it just means the sub was created before we started
    // tracking, or it belongs to a different product. Skip silently.
    console.log(`Subscription ${event.type} — updated ${rows.length} row(s) for ${subId}:`, patch);
    return res.status(200).json({ ok: true, updated: rows.length, subId, patch });
  } catch (err) {
    console.error('Subscription event update failed:', err);
    return res.status(200).json({ ok: false, error: String(err && err.message || err), subId });
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET env var not set');
    return res.status(500).json({ error: 'Webhook not configured (missing STRIPE_WEBHOOK_SECRET)' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('Failed to read raw body:', err);
    return res.status(400).json({ error: 'Failed to read request body' });
  }

  const sigHeader = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
    console.error('Invalid Stripe signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('Failed to parse event JSON:', err);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Studio subscription lifecycle events go through their own handler
  // (mark cancelled, update current_period_end, etc.). They don't touch
  // the checkout flow below.
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    return handleStudioSubscriptionEvent(event, res);
  }

  // Everything else must be a checkout completion.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ ok: true, ignored: event.type });
  }

  const session = (event.data && event.data.object) || {};
  const metadata = session.metadata || {};
  const kind = metadata.kind;          // 'cohort' | 'private' | 'studio'
  const signup_id = metadata.signup_id;

  if (!kind) {
    console.error('Webhook missing metadata.kind', metadata);
    return res.status(200).json({ ok: true, skipped: 'missing kind' });
  }

  const table =
    kind === 'cohort'  ? 'refresh_signups' :
    kind === 'private' ? 'confidant_requests' :
    kind === 'studio'  ? 'studio_members' :
    kind === 'event'   ? 'event_tickets' :
    null;

  if (!table) {
    console.error('Webhook unknown kind:', kind);
    return res.status(200).json({ ok: true, skipped: `unknown kind: ${kind}` });
  }

  // Pull customer details from the session — Stripe collected these.
  const customerEmail = (session.customer_details && session.customer_details.email) || session.customer_email || '';
  const customerName  = (session.customer_details && session.customer_details.name)  || metadata.customer_name || '';
  const customerPhone = (session.customer_details && session.customer_details.phone) || '';
  const slotMeta      = (metadata.slot || '').toLowerCase();

  try {
    let rows;
    if (signup_id) {
      // EXISTING FLOW: a row was pre-created by the form helper. UPDATE it.
      const patch = {
        status: 'paid',
        stripe_session_id: session.id,
        paid_amount_cents: session.amount_total ?? null,
        paid_at: new Date().toISOString(),
      };
      rows = await supabasePatch({ table, id: signup_id, patch });
    } else {
      // NEW EMBEDDED FLOW: no pre-created row. CREATE one from Stripe data.
      // Only cohort uses this for now; private still always pre-creates.
      let row;
      if (table === 'refresh_signups') {
        const preferredTime = slotMeta === '8pm' ? 'Tuesdays at 8 PM ET' : 'Tuesdays at 11 AM ET';
        row = {
          full_name: customerName || 'Stripe Customer',
          email: customerEmail,
          phone: customerPhone || '',
          audience_type: 'groups',
          group_type: 'no_preference',
          preferred_group_time: preferredTime,
          readiness: 'ready_to_pay',
          consent_to_contact: true,
          consent_to_confidentiality: true,
          status: 'enrolled',
          stripe_session_id: session.id,
          paid_amount_cents: session.amount_total ?? null,
          paid_at: new Date().toISOString(),
        };
      } else if (table === 'studio_members') {
        // ReBe Studio subscription. Plan is inferred from amount:
        //   $30.00 (3000c)  → monthly
        //   $300.00 (30000c) → annual
        // Anything else defaults to 'monthly' so a partial/pro-rated payment
        // still lands somewhere sane (admin can correct in Supabase later).
        const plan = session.amount_total === 30000 ? 'annual' : 'monthly';
        row = {
          full_name: customerName || 'Stripe Customer',
          email: customerEmail,
          phone: customerPhone || '',
          plan,
          status: 'active',
          stripe_customer_id: session.customer || null,
          stripe_session_id: session.id,
          stripe_subscription_id: session.subscription || null,
          paid_amount_cents: session.amount_total ?? null,
          paid_at: new Date().toISOString(),
        };
      } else if (table === 'event_tickets') {
        // Fallback only — the event page pre-creates the row and passes
        // signup_id, so this runs solely if that insert didn't happen.
        row = {
          full_name: customerName || 'Stripe Customer',
          email: customerEmail,
          phone: customerPhone || '',
          event_slug: metadata.event_slug || 'night-to-shift',
          status: 'paid',
          stripe_session_id: session.id,
          paid_amount_cents: session.amount_total ?? null,
          paid_at: new Date().toISOString(),
        };
      } else {
        // Defensive — should never hit this for 1:1 since we always pre-create
        row = {
          name: customerName || 'Stripe Customer',
          email: customerEmail,
          phone: customerPhone || '',
          status: 'paid',
          stripe_session_id: session.id,
          paid_amount_cents: session.amount_total ?? null,
          paid_at: new Date().toISOString(),
        };
      }
      rows = await supabaseInsert({ table, row });
    }

    // Event ticket → send the buyer their branded confirmation email
    // (details + add-to-calendar + invite-a-friend). Awaited so Vercel
    // doesn't tear the function down mid-send; a failure is logged, not
    // fatal (the ticket is already saved + Stripe sends its own receipt).
    if (customerEmail && kind === 'event') {
      try {
        await sendEventConfirmation({
          to: customerEmail,
          firstName: (customerName || '').trim().split(/\s+/)[0] || '',
        });
      } catch (e) {
        console.error('Event confirmation email (stripe-webhook):', e);
      }
    }

    // Tag the customer in Kit with the full set so Kit segmentation works:
    //   - 'ReBe — All'                 : master audience tag
    //   - 'ReBe — Cohort'              : everyone touching the 5-week cohort
    //   - 'ReBe — Customer (Paid)'     : paid customers across products
    //   - 'Cohort · 11 AM · Paid' OR 'Cohort · 8 PM · Paid' : slot-specific
    //     so Kit automations can fire the right welcome / prep series per group
    //
    // Await it so Vercel doesn't tear down the function before the Kit call
    // finishes. A Kit failure shouldn't fail the webhook (Stripe would retry
    // and we'd double-insert), so we swallow the error after logging it.
    if (customerEmail && kind === 'cohort') {
      try {
        const slotTag = slotMeta === '8pm' ? 'Cohort · 8 PM · Paid' : 'Cohort · 11 AM · Paid';
        await kitSubscribe({
          email: customerEmail,
          first_name: customerName.trim().split(/\s+/)[0] || '',
          tags: ['ReBe — All', 'ReBe — Cohort', 'ReBe — Customer (Paid)', slotTag],
        });
      } catch (e) {
        console.error('Kit (stripe-webhook):', e);
      }
    } else if (customerEmail && kind === 'studio') {
      // Studio subscription — tag with the full Studio member set
      try {
        await kitSubscribe({
          email: customerEmail,
          first_name: customerName.trim().split(/\s+/)[0] || '',
          tags: ['ReBe — All', 'ReBe — Studio', 'ReBe — Studio · Paid', 'ReBe — Customer (Paid)'],
        });
      } catch (e) {
        console.error('Kit (stripe-webhook):', e);
      }
    } else if (customerEmail) {
      // Non-cohort purchases (1:1 etc.) — keep the original single-tag behavior
      try {
        await kitSubscribe({
          email: customerEmail,
          first_name: customerName.trim().split(/\s+/)[0] || '',
          tags: ['ReBe — Customer (Paid)'],
        });
      } catch (e) {
        console.error('Kit (stripe-webhook):', e);
      }
    }

    // Welcome email to the customer + new-purchase notification to admin.
    // Wrap each in try/catch so an email failure never fails the webhook
    // (Stripe would retry and we'd double-insert into Supabase).
    if (kind === 'cohort' && customerEmail && process.env.RESEND_API_KEY) {
      const firstName = (customerName || '').trim().split(/\s+/)[0] || 'friend';
      const slotPretty = slotMeta === '8pm' ? '8 PM Eastern time (5 PM Pacific)' : '11 AM Eastern time (8 AM Pacific)';
      const slotShort  = slotMeta === '8pm' ? '8 PM Eastern' : '11 AM Eastern';
      const zoomLink   = slotMeta === '8pm' ? 'https://us06web.zoom.us/j/81155916766' : 'https://us06web.zoom.us/j/88554567062';
      const slotGroup  = slotMeta === '8pm' ? '8 PM Zoom Group' : '11 AM Zoom Group';
      const fromAddr   = process.env.NOTIFY_FROM || 'ReBe ReFresh <refresh@justrebe.com>';
      const adminAddr  = process.env.NOTIFY_ADMIN || 'refresh@justrebe.com';
      const resendKey  = process.env.RESEND_API_KEY;

      // Customer welcome
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromAddr,
            to: customerEmail,
            subject: `Welcome to ReBe ReFresh, ${firstName} — see you June 23`,
            text:
`Hi ${firstName},

Welcome to the first ReBe ReFresh cohort. We are so excited that you said yes — and we cannot wait to be in the room with you.

This is the start of something beautiful. Five weeks together — five Tuesdays — to slow down, reset, reconnect, and remember who you actually are. We are so honored that you're walking this with us.

You are confirmed for the ${slotPretty} cohort, every Tuesday from June 23 to July 21, 2026.

YOUR ZOOM LINK (save this — it's the same link every Tuesday for all 5 weeks):

${slotGroup}
${zoomLink}

PLEASE FILL OUT YOUR INTAKE FORM (about 3 minutes):

https://www.justrebe.com/thank-you-cohort?slot=${slotMeta || '11am'}&session_id=${session.id}

Elizabeth and the team use this to prepare for you — what you're bringing in, what you need from the room, how to make it feel like home. It really matters.

WHAT ELSE TO KNOW:

- Save the dates: every Tuesday, June 23 through July 21, ${slotPretty}.

- Watch your inbox for a follow-up with format details, what to expect, and how to come prepared.

QUESTIONS? Just reply to this email — we read every single one and we'd love to hear from you.

We cannot wait to be with you.

Warmly,
Elizabeth & the ReBe ReFresh Team
refresh@justrebe.com
https://www.justrebe.com/refresh-cohort`,
          }),
        });
      } catch (e) {
        console.error('Welcome email (customer) failed:', e);
      }

      // Admin notification
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromAddr,
            to: adminAddr,
            subject: `🎉 New cohort signup — ${customerName || customerEmail} (${slotShort})`,
            text:
`A new ReBe ReFresh cohort signup just came through.

CUSTOMER
  Name:               ${customerName || '(not given)'}
  Email:              ${customerEmail}
  Phone:              ${customerPhone || '(not given)'}
  Cohort slot:        ${slotShort}
  Amount paid:        $${((session.amount_total || 0) / 100).toFixed(2)}

STRIPE
  Session id:         ${session.id}
  Event id:           ${event.id}
  Paid at:            ${new Date().toISOString()}

The customer's welcome email (with their Zoom link) has already been sent.

— ReBe webhook`,
          }),
        });
      } catch (e) {
        console.error('Admin notification email failed:', e);
      }
    }

    // ------- ReBe Studio CRM sync (contacts + customer_tags + Quo) -------
    // Runs only for Studio signups. Mirrors what Osil was doing by hand:
    //   1. Upsert into `contacts` so they appear in the admin/CRM customer list
    //   2. Insert 4 rows into `customer_tags`: ReBe Studio, Paid, price, plan
    //   3. Push to OpenPhone/Quo as a contact (only if a phone was collected)
    // Failures on any one step are logged and swallowed so the welcome
    // email still fires.
    if (kind === 'studio' && customerEmail) {
      const [firstName, ...lastRest] = (customerName || '').trim().split(/\s+/);
      const lastName = lastRest.join(' ');
      const isAnnual = session.amount_total === 30000;
      const planTag  = isAnnual ? 'Annual' : 'Monthly';
      const priceTag = isAnnual ? '$300'   : '$30';

      const url = supabaseBaseUrl();
      const key = supabaseKey();

      // 1) Contacts upsert (on_conflict=email so re-signups don't error out).
      try {
        const r = await fetch(`${url}/rest/v1/contacts?on_conflict=email`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify({
            first_name: firstName || null,
            last_name: lastName || null,
            email: customerEmail,
            phone: customerPhone || null,
          }),
        });
        if (!r.ok) {
          const detail = await r.text();
          console.error(`contacts upsert ${r.status}:`, detail);
        }
      } catch (e) {
        console.error('contacts upsert threw:', e);
      }

      // 2) customer_tags: 4 tags per Studio signup.
      const nowIso = new Date().toISOString();
      const tagRows = ['ReBe Studio', 'Paid', priceTag, planTag].map((tag) => ({
        customer_email: customerEmail,
        tag,
        added_by_email: 'stripe-webhook@justrebe.com',
        added_at: nowIso,
      }));
      try {
        const r = await fetch(`${url}/rest/v1/customer_tags`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(tagRows),
        });
        // 409 = duplicate (webhook retry) — safe to ignore. Anything else logs.
        if (!r.ok && r.status !== 409) {
          const detail = await r.text();
          console.error(`customer_tags insert ${r.status}:`, detail);
        }
      } catch (e) {
        console.error('customer_tags insert threw:', e);
      }

      // 3) OpenPhone / Quo contact — only fires when a phone was collected.
      // Enable phone collection on the Studio Payment Links to activate this.
      if (customerPhone) {
        try {
          await createOpenPhoneContact({
            firstName: firstName || '',
            lastName: lastName || '',
            email: customerEmail,
            phone: customerPhone,
            source: `ReBe Studio · Paid · ${planTag}`,
          });
        } catch (e) {
          console.error('OpenPhone push (studio):', e);
        }
      }
    }

    // ReBe Studio welcome email (subscription product).
    // Fires once, on the initial checkout.session.completed. Renewals fire
    // invoice.paid, which this webhook ignores — so no duplicate welcomes.
    if (kind === 'studio' && customerEmail && process.env.RESEND_API_KEY) {
      const firstName = (customerName || '').trim().split(/\s+/)[0] || 'friend';
      const fromAddr  = process.env.NOTIFY_FROM || 'ReBe ReFresh <refresh@justrebe.com>';
      const adminAddr = process.env.NOTIFY_ADMIN || 'refresh@justrebe.com';
      const resendKey = process.env.RESEND_API_KEY;

      // Customer welcome
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromAddr,
            to: customerEmail,
            subject: `You're in — welcome to ReBe Studio, ${firstName}`,
            text:
`Hi ${firstName},

You're in. Welcome to ReBe Studio.

You said yes — and that mattered. Your seat is set.

ReBe Studio is a community across the five EPICS: Emotional, Physical, Intellectual, Cultural, and Spiritual Health. Live Confidant sessions, a growing library of videos and resources, in-person pop-ups, and priority access to the next ReFresh Cohort.

WHAT'S ON THE CALENDAR THIS MONTH:

"Who Am I?" with Beth Rech and Fred Feller
Thursday, July 9, 7 PM Eastern
Emotional Health

"How to Use Your Brain for a CHANGE" with Dr. Jason Quintal
Wednesday, July 15 and July 22, 4:30 PM Eastern (two parts, one registration)
Mental Health

Happy Hour with Osil Pistole
1st and 3rd Friday of the month, 5 PM Eastern
Drop in — no registration needed

YOUR STUDIO HUB (bookmark this):
https://www.justrebe.com/rebe-studio

Every session, every replay, every resource lives there. That's your room.

Come Rewrite. Come Belong. Come Be known.

Something on your heart before your first session? Just reply to this email — we read every single one.

With so much warmth,
Elizabeth and the ReBe team
refresh@justrebe.com
https://www.justrebe.com/rebe-studio`,
          }),
        });
      } catch (e) {
        console.error('Studio welcome email (customer) failed:', e);
      }

      // Admin notification
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromAddr,
            to: adminAddr,
            subject: `New ReBe Studio member — ${customerName || customerEmail}`,
            text:
`A new ReBe Studio member just signed up.

CUSTOMER
  Name:               ${customerName || '(not given)'}
  Email:              ${customerEmail}
  Phone:              ${customerPhone || '(not given)'}
  Amount paid:        $${((session.amount_total || 0) / 100).toFixed(2)}

STRIPE
  Session id:         ${session.id}
  Event id:           ${event.id}
  Paid at:            ${new Date().toISOString()}

The customer's welcome email has already been sent.

— ReBe webhook`,
          }),
        });
      } catch (e) {
        console.error('Studio admin notification failed:', e);
      }
    }

    return res.status(200).json({ ok: true, updated: rows.length, table, signup_id: signup_id || (rows[0] && rows[0].id) || null });
  } catch (err) {
    // Detailed log so the failure shows up clearly in Vercel function logs.
    console.error('Webhook Supabase update failed', {
      error: String(err && err.message || err),
      stripe_session_id: session.id,
      stripe_event_id: event.id,
      kind,
      table,
      signup_id: signup_id || null,
      customer_email: customerEmail,
      amount_total: session.amount_total,
    });

    // Send the admin a payment-recovery email so the payment is never lost
    // even if Supabase rejected the update. Fire and forget — don't block the
    // webhook response on email delivery.
    try {
      const fromAddr = process.env.NOTIFY_FROM || 'ReBe ReFresh <refresh@justrebe.com>';
      const adminAddr = process.env.NOTIFY_ADMIN || 'refresh@justrebe.com';
      const resendKey = process.env.RESEND_API_KEY;
      if (resendKey) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromAddr,
            to: adminAddr,
            subject: `🚨 Stripe webhook DB update failed — manual review needed (${kind})`,
            text:
`A Stripe payment came through but the Supabase update failed.
The customer was charged successfully; only the database wasn't updated.

PAYMENT
  Kind:              ${kind}
  Customer email:    ${customerEmail || '(not given)'}
  Customer name:     ${customerName || '(not given)'}
  Amount:            $${((session.amount_total || 0) / 100).toFixed(2)}
  Stripe session id: ${session.id}
  Stripe event id:   ${event.id}
  Signup id (metadata): ${signup_id || '(none)'}

DATABASE TARGET
  Table:             ${table}
  Operation:         ${signup_id ? 'PATCH (by signup_id)' : 'INSERT'}

ERROR
  ${String(err && err.message || err)}

NEXT STEPS
  1) Look the customer up in Supabase by email or stripe_session_id.
  2) Manually set status='paid' (and stripe_session_id/paid_at if needed).
  3) Verify the customer received their confirmation email from Stripe.

— ReBe webhook`
          }),
        });
      }
    } catch (e) { console.error('Recovery email failed:', e); }

    // Return 200 so Stripe stops retrying. The payment + the error are now
    // both captured (Stripe has the charge; we have the recovery email).
    return res.status(200).json({
      ok: false,
      recovered_via_email: true,
      error: 'Supabase update failed',
      detail: String(err && err.message || err),
    });
  }
};
